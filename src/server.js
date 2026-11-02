/**
 * server.js — the HTTP API and the small web page.
 *
 * Every call needs the token: `Authorization: Bearer <token>` (tools, FLE Link), or the cookie the page gets after
 * signing in with a one-time code (`POST /api/session/code` with the token, then open `/?code=…`). A write with the
 * cookie also needs the header `X-FLE-Durable: 1`, which a foreign page cannot send without a preflight this server
 * never answers.
 *
 *   GET    /api/health                   model, storage, queue and sources
 *   GET    /api/conversation             the main conversation (entries, oldest first)
 *   GET    /api/stream                   server-sent events of the main conversation (pi-durable events)
 *   POST   /api/message    {text, id?}   the owner writes (goes before background events)
 *   POST   /api/abort                    stop the running turn
 *   GET    /api/agenda · POST /api/agenda · DELETE /api/agenda/<id> · POST /api/agenda/<id>/pause {paused}
 *   POST   /api/events     {text, id?, from?, ref?}   webhook: a background event into the queue
 *   GET    /api/queue · POST /api/queue/pause {paused}
 *   GET    /api/approvals · POST /api/approvals/<id> {decision: granted|refused, note?}
 *   POST   /api/session/code             a one-time sign-in code for the page (Bearer only)
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicView } from './config.js';
import { watch } from './pi.js';
import { BACKGROUND, OWNER } from './queue.js';

const PUBLIC = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const COOKIE = 'fle_durable';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
const json = (res, status, data) => send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });

async function readJson(req, limit) {
  let size = 0;
  const parts = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'request too large');
    parts.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('object expected');
    return v;
  } catch (e) {
    throw new HttpError(400, `invalid JSON: ${e.message}`);
  }
}

const same = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

function cookieOf(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return '';
}

/** One-time sign-in codes: valid once, for 60 seconds. */
class Codes {
  constructor() {
    this.open = new Map();
  }
  issue() {
    const now = Date.now();
    for (const [c, t] of this.open) if (now - t > 60_000) this.open.delete(c);
    if (this.open.size > 20) return null;
    const code = randomBytes(18).toString('base64url');
    this.open.set(code, now);
    return code;
  }
  redeem(code) {
    const t = this.open.get(code);
    this.open.delete(code);
    return t !== undefined && Date.now() - t <= 60_000;
  }
}

function serveStatic(res, path) {
  const rel = path === '/' ? 'index.html' : path.slice(1);
  const file = resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  });
  createReadStream(file).pipe(res);
}

/** SSE of the main conversation: first the snapshot, then every batch of events; a comment every 20 s keeps it open. */
async function stream(req, res, runner) {
  const conv = await runner.mainConversation();
  const w = await watch(runner.harness, conv.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const out = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  out('snapshot', { entries: w.snapshot?.entries ?? [] });
  w.start(async (events) => out('events', events));
  const beat = setInterval(() => res.writableEnded || res.write(': beat\n\n'), 20_000);
  beat.unref?.();
  req.on('close', () => {
    clearInterval(beat);
    void w.stop();
  });
}

export function createApiServer({ cfg, runner, queue, sources = [] }) {
  const codes = new Codes();
  const limit = cfg.limits.bodyBytes;

  async function api(req, res, path, cookieAuth) {
    const m = req.method;
    if (cookieAuth && m !== 'GET' && req.headers['x-fle-durable'] !== '1') throw new HttpError(403, 'header X-FLE-Durable: 1 missing');
    const body = () => readJson(req, limit);
    const parts = path.split('/').filter(Boolean); // ['api', ...]

    if (path === '/api/health' && m === 'GET') {
      return json(res, 200, {
        ok: true,
        ...publicView(cfg),
        runner: runner.health(),
        queue: queue.health(),
        sources: Object.fromEntries(sources.map((s) => [s.name, s.variant.state?.() ?? null])),
      });
    }
    if (path === '/api/session/code' && m === 'POST') {
      if (cookieAuth) throw new HttpError(403, 'a code needs the token as Bearer');
      const code = codes.issue();
      if (!code) throw new HttpError(429, 'too many open codes');
      return json(res, 200, { ok: true, code, valid_s: 60 });
    }
    if (path === '/api/conversation' && m === 'GET') return json(res, 200, { ok: true, entries: await runner.history() });
    if (path === '/api/stream' && m === 'GET') return stream(req, res, runner);
    if (path === '/api/message' && m === 'POST') {
      const b = await body();
      const text = String(b.text ?? '').trim();
      if (!text) throw new HttpError(400, 'text is required');
      const id = `chat:${String(b.id ?? '').trim().slice(0, 80) || randomUUID()}`;
      const queued = await queue.enqueue({ id, text, source: 'chat', from: 'owner', priority: OWNER });
      return json(res, 202, { ok: true, id, queued });
    }
    if (path === '/api/abort' && m === 'POST') {
      await runner.abort();
      return json(res, 200, { ok: true });
    }
    if (path === '/api/events' && m === 'POST') {
      if (!cfg.events.enabled) throw new HttpError(503, 'events are off');
      const b = await body();
      const text = String(b.text ?? '').trim();
      if (!text) throw new HttpError(400, 'text is required');
      const id = `webhook:${String(b.id ?? '').trim().slice(0, 120) || randomUUID()}`;
      const queued = await queue.enqueue({ id, text: text.slice(0, 8000), source: 'webhook', from: String(b.from ?? 'webhook').slice(0, 64), ref: b.ref ? String(b.ref).slice(0, 120) : null, priority: BACKGROUND });
      return json(res, queued ? 202 : 200, { ok: true, id, queued });
    }
    if (path === '/api/queue' && m === 'GET') {
      const q = await queue.list();
      return json(res, 200, { ok: true, ...q, entries: q.entries.map((e) => ({ ...e, text: e.text.slice(0, 280) })) });
    }
    if (path === '/api/queue/pause' && m === 'POST') return json(res, 200, { ok: true, ...(await queue.pause((await body()).paused !== false)) });

    if (parts[1] === 'agenda') {
      const a = runner.agenda;
      const bad = (e) => new HttpError(400, e?.message ?? String(e));
      if (parts.length === 2 && m === 'GET') return json(res, 200, { ok: true, ...(await a.list()) });
      if (parts.length === 2 && m === 'POST') {
        const b = await body();
        try {
          return json(res, 201, { ok: true, item: await a.add(b, 'owner') });
        } catch (e) {
          throw bad(e);
        }
      }
      const id = parts[2] ?? '';
      if (!/^a[0-9a-z]{4,30}$/.test(id)) throw new HttpError(400, 'unknown agenda id');
      try {
        if (parts.length === 3 && m === 'DELETE') return json(res, 200, { ok: true, item: await a.remove(id, 'owner') });
        if (parts.length === 4 && parts[3] === 'pause' && m === 'POST') return json(res, 200, { ok: true, item: await a.pause(id, (await body()).paused !== false) });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw bad(e);
      }
    }
    if (parts[1] === 'approvals') {
      if (parts.length === 2 && m === 'GET') return json(res, 200, { ok: true, approvals: await runner.approvals() });
      if (parts.length === 3 && m === 'POST') {
        const b = await body();
        try {
          return json(res, 200, { ok: true, approvals: await runner.decideApproval(decodeURIComponent(parts[2]), { decision: b.decision, note: b.note, by: 'owner' }) });
        } catch (e) {
          throw new HttpError(400, e.message);
        }
      }
    }
    throw new HttpError(404, `unknown route: ${m} ${path}`);
  }

  return createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return json(res, 400, { ok: false, error: 'bad address' });
    }
    const path = url.pathname;
    try {
      // one-time code: page opened with ?code=… → cookie, then the same address without the code
      if (req.method === 'GET' && !path.startsWith('/api/') && url.searchParams.has('code')) {
        if (!codes.redeem(url.searchParams.get('code') ?? '')) return json(res, 401, { ok: false, error: 'code invalid, expired or used' });
        return send(res, 302, '', { Location: '/', 'Set-Cookie': `${COOKIE}=${encodeURIComponent(cfg.token)}; HttpOnly; SameSite=Strict; Path=/` });
      }
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const viaBearer = same(bearer, cfg.token);
      const viaCookie = !viaBearer && same(cookieOf(req), cfg.token);
      if (!viaBearer && !viaCookie) {
        if (path.startsWith('/api/')) return json(res, 401, { ok: false, error: 'token required' });
        return send(res, 401, 'Sign in: ask your launcher (for example FLE Link) to open this page, or POST /api/session/code with the token.', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      if (path.startsWith('/api/')) return await api(req, res, path, viaCookie);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return serveStatic(res, path);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error(`[fle-durable] ${req.method} ${path}:`, e);
      if (!res.headersSent) json(res, status, { ok: false, error: e.message || 'error' });
      else res.end();
    }
  });
}

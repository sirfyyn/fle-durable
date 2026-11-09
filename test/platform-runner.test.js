/**
 * The whole way, without FYOS: the real runner with a fake model, no hub, no Redis, no network beyond its own port.
 * Webhook → bus → queue → agent; tickets and calendar over REST and as the agent's tools; the actor comes from the token;
 * everything is still there after a restart.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { DURABLE_DEFAULT_SOURCES, durableKonfiguration } from '../src/durable.js';
import { Ingress } from '../src/ingress.js';
import { konfigurationLaden } from '../src/config.js';
import { actorForToken } from '../src/platform/index.js';
import { ownerName } from '../src/ports/contracts.js';
import { loadPort } from '../src/ports/load.js';
import { builtinSources } from '../src/ports/sources.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';

const TOKEN = 'test-token-test-token-test-token-00';
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'plattform-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const until = async (fn, what) => {
  for (let i = 0; i < 400; i += 1) {
    if (await fn()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.fail(`not reached: ${what}`);
};

async function withRunner(name, fn, extra = {}) {
  const cfg = durableKonfiguration(
    { FYOS_RUNNER_ORDNER_ERLAUBT: tmp },
    {
      owner: 'max',
      agent: 'paula',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: { storage: join(tmp, `${name}.sqlite`), security: { token: TOKEN, tokens: { helper: 'helper-token-helper-token-helper-00' } } },
      ...extra,
    },
  );
  const lanes = [...new Set([cfg.pi_durable.model.default, cfg.pi_durable.model.max].filter(Boolean))];
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: lanes.map((id) => ({ id })) });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage('ok')));
  const runner = new Runner(cfg, { models });
  await runner.start();
  const ingress = new Ingress({ cfg, runner, hub: null, spielmodus: runner.spielmodusEinlass, tor: null, ruhe: runner.ruhe });
  const sources = await loadPort('sources', {
    cfg,
    ctx: { cfg, hub: null, harness: runner.harness, enqueue: (e) => ingress.einreihen(e), runner, owner: ownerName(cfg) },
    known: builtinSources,
    defaults: DURABLE_DEFAULT_SOURCES,
  });
  await ingress.start();
  for (const s of sources) s.variant.start();
  const server = erstelleServer({ runner, cfg, ingress });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, token = TOKEN } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    await fn({ call, runner, ingress, cfg, faux, base, sources });
  } finally {
    await Promise.allSettled(sources.map((s) => s.variant.stop()));
    await ingress.stop().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((ok) => server.close(ok));
    await runner.close().catch(() => {});
  }
}

test('without FYOS: an event over REST reaches the agent; no token, no entry', async () => {
  await withRunner('ereignis', async ({ call, runner, cfg, faux }) => {
    assert.equal(cfg.hub, '');
    assert.equal((await call('POST', '/api/bus', { body: { text: 'x' }, token: '' })).status, 401);
    const pending = faux.getPendingResponseCount();
    const r = await call('POST', '/api/bus', { body: { id: 'build-42', source: 'ci', text: 'Build 42 failed', severity: 'high', class: 'max' } });
    assert.equal(r.status, 202);
    assert.equal(r.json.event.class, 'hintergrund', 'nothing from outside gets the owner class');
    await until(() => faux.getPendingResponseCount() < pending, 'the agent got a turn');
    await until(() => runner.platform.bus.cursor('agent') === r.json.event.seq, 'acknowledged');
    assert.equal((await call('POST', '/api/bus', { body: { id: 'build-42', source: 'ci', text: 'Build 42 failed' } })).status, 200, 'same id: same event');
    const read = await call('GET', '/api/bus?after=0');
    assert.equal(read.json.events.length, 1);
    assert.equal(read.json.last, r.json.event.seq);
    assert.equal((await call('POST', '/api/bus', { body: { source: 'ci', text: ' ' } })).status, 400);
    assert.ok((await call('GET', '/api/bus/state')).json.topics.some((t) => t.topic === 'inbox'));
  });
});

test('SSE: old events after the given position, then new ones live', async () => {
  await withRunner('strom', async ({ call, base }) => {
    await call('POST', '/api/bus', { body: { id: 'a', topic: 'test', source: 's', text: 'first' } });
    const abort = new AbortController();
    const res = await fetch(`${base}/api/bus/stream?topic=test&after=0`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: abort.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const seen = async (word) => {
      while (!text.includes(word)) {
        const { value, done } = await reader.read();
        if (done) assert.fail('stream ended');
        text += decoder.decode(value);
      }
    };
    await seen('first');
    await call('POST', '/api/bus', { body: { id: 'b', topic: 'test', source: 's', text: 'second' } });
    await seen('second');
    assert.match(text, /event: bus/);
    abort.abort();
  });
});

test('tickets over REST: the actor comes from the token, not from the body; approvals wake the agent', async () => {
  await withRunner('vorgaenge', async ({ call, runner, faux }) => {
    const created = await call('POST', '/api/tickets', { body: { title: 'Darf ich neu starten?', type: 'CHG', status: 'waiting_approval', actor: 'paula', reporter: 'paula' } });
    assert.equal(created.status, 201);
    const { id } = created.json.ticket;
    assert.equal(created.json.ticket.reporter, 'max', 'the runner token is the owner, whatever the body says');

    const helper = 'helper-token-helper-token-helper-00';
    const forged = await call('PATCH', `/api/tickets/${id}`, { body: { status: 'closed', actor: 'max' }, token: helper });
    assert.equal(forged.status, 403, 'another token cannot act as the owner');
    assert.equal(actorForToken(runner.platform, 'max'), 'system');

    const before = faux.getPendingResponseCount();
    const granted = await call('PATCH', `/api/tickets/${id}`, { body: { status: 'in_progress', expected_status: 'waiting_approval' } });
    assert.equal(granted.json.ticket.status, 'in_progress');
    await until(() => faux.getPendingResponseCount() < before, 'the agent was woken');
    assert.equal((await call('PATCH', `/api/tickets/${id}`, { body: { status: 'triage', expected_status: 'waiting_approval' } })).status, 409);

    assert.equal((await call('POST', `/api/tickets/${id}/comments`, { body: { text: 'Bitte vorsichtig' } })).status, 201);
    const detail = await call('GET', `/api/tickets/${id}`);
    assert.ok(detail.json.ticket.verlauf.some((h) => h.event === 'comment' && h.actor === 'max'));
    assert.equal((await call('GET', '/api/tickets?status=in_progress')).json.total, 1);
    assert.equal((await call('GET', '/api/tickets/board')).json.columns.in_progress, 1);
    assert.equal((await call('GET', '/api/tickets/waiting')).json.anzahl, 0);
    assert.equal((await call('GET', '/api/tickets/INC-P999')).status, 404);
    assert.equal((await call('POST', `/api/tickets/${id}/archive`, { body: { reason: 'Test' } })).json.ticket.archive_reason, 'Test');
    assert.equal((await call('GET', '/api/tickets?archived=1')).json.total, 1);
    assert.equal((await call('DELETE', `/api/tickets/${id}/archive`)).json.ticket.archived_at, '');
  });
});

test('calendar over REST: entries, moving, busy', async () => {
  await withRunner('kalender', async ({ call }) => {
    const created = await call('POST', '/api/calendar', { body: { title: 'Lasttest', from: '2030-01-07T10:00:00Z', to: '2030-01-07T12:00:00Z', exklusiv: 'hauptserver' } });
    assert.equal(created.status, 201);
    const { id, actor } = created.json.entry;
    assert.equal(actor, 'max');
    const moved = await call('PATCH', `/api/calendar/${id}`, { body: { from: '2030-01-07T14:00:00Z' } });
    assert.equal(moved.json.entry.to, '2030-01-07T16:00:00.000Z');
    assert.equal((await call('GET', '/api/calendar/busy?target=hauptserver&at=2030-01-07T15:00:00Z')).json.busy, true);
    assert.equal((await call('GET', '/api/calendar/busy?target=hauptserver&at=2030-01-07T11:00:00Z')).json.busy, false);
    const w = await call('GET', '/api/calendar?from=2030-01-07T00:00:00Z&to=2030-01-08T00:00:00Z');
    assert.equal(w.json.entries.length, 1);
    assert.equal(w.json.complete, true);
    assert.equal((await call('GET', `/api/calendar/${id}`)).json.entry.title, 'Lasttest');
    assert.equal((await call('POST', '/api/calendar', { body: { title: 'ohne Zeit' } })).status, 400);
    assert.equal((await call('DELETE', `/api/calendar/${id}`)).status, 200);
    assert.equal((await call('GET', `/api/calendar/${id}`)).status, 404);
  });
});

test('the agent’s tools act as the agent; it cannot close or grant', async () => {
  await withRunner('werkzeuge', async ({ runner }) => {
    const { platformTools } = await import('../src/platform/tools.js');
    const list = Object.fromEntries(platformTools(() => runner.platform).map((t) => [t.name, t]));
    const run = (name, args) => list[name].execute(args, {}, undefined);
    const created = await run('ticket_create', { title: 'Plan', type: 'VOR' });
    const { id } = created.details.ticket;
    assert.equal(created.details.ticket.reporter, 'paula');
    assert.equal(created.details.ticket.status, 'triage');
    const closed = await run('ticket_update', { id, status: 'closed' });
    assert.match(closed.output[0].text, /Refused: only a human/);
    const missing = await run('ticket_get', { id: 'INC-P999' });
    assert.match(missing.output[0].text, /Refused: no ticket/);
    await run('ticket_comment', { id, text: 'Befund' });
    assert.equal(runner.platform.tickets.history(id)[0].actor, 'paula');
    assert.match((await run('ticket_list', { q: 'Plan' })).output[0].text, /1 tickets/);
    const planned = await run('calendar_add', { title: 'Bau', from: '2030-01-07T10:00:00Z', exklusiv: 'hauptserver' });
    assert.equal(planned.details.entry.actor, 'paula');
    assert.match((await run('calendar_busy', { target: 'hauptserver', at: '2030-01-07T10:30:00Z' })).output[0].text, /is taken/);
    assert.match((await run('calendar_list', { from: '2030-01-07T00:00:00Z', to: '2030-01-08T00:00:00Z' })).output[0].text, /Bau/);
    assert.match((await run('calendar_update', { id: planned.details.entry.id, from: '2030-01-07T12:00:00Z' })).output[0].text, /12:00/);
  });
});

test('memo: a replayed tool call acts once', async () => {
  await withRunner('wiederholung', async ({ runner }) => {
    const { platformTools } = await import('../src/platform/tools.js');
    const tool = platformTools(() => runner.platform).find((t) => t.name === 'ticket_create');
    const memo = new Map();
    const api = { memo: async (key, value) => (memo.has(key) ? memo.get(key) : (memo.set(key, value), value)) };
    const a = await tool.execute({ title: 'Einmal' }, api);
    const b = await tool.execute({ title: 'Einmal' }, api);
    assert.equal(a.details.ticket.id, b.details.ticket.id);
    assert.equal(runner.platform.tickets.list({ q: 'Einmal' }).total, 1);
  });
});

test('durable: tickets, calendar and bus are still there after a restart', async () => {
  let id;
  await withRunner('neustart', async ({ call }) => {
    id = (await call('POST', '/api/tickets', { body: { title: 'Bleibt' } })).json.ticket.id;
    await call('POST', '/api/calendar', { body: { title: 'Bleibt auch', from: '2030-01-07T10:00:00Z' } });
  });
  await withRunner('neustart', async ({ call }) => {
    assert.equal((await call('GET', `/api/tickets/${id}`)).json.ticket.title, 'Bleibt');
    assert.equal((await call('GET', '/api/calendar?from=2030-01-07T00:00:00Z&to=2030-01-08T00:00:00Z')).json.entries.length, 1);
    assert.ok((await call('POST', '/api/tickets', { body: { title: 'Neu' } })).json.ticket.id !== id, 'the numbering goes on');
  });
});

test('the platform is off by default for an existing setup: routes answer 503, no file, no tools', async () => {
  const cfg = konfigurationLaden({ arbeitsbereiche: { standard: { pfad: tmp } }, pi_durable: { storage: join(tmp, 'aus.sqlite'), security: { token: TOKEN } } }, {});
  assert.equal(cfg.platform?.an, undefined);
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runner = new Runner(cfg, { models, hub: { aufrufen: async () => ({ ok: true, result: {} }), melden: async () => ({ ok: true }), bereicheMelden: async () => ({ ok: true }), gesundheit: async () => ({ ok: true }), suchen: async () => [], schema: async () => ({}) } });
  await runner.start();
  assert.equal(runner.platform, null);
  const server = erstelleServer({ runner, cfg });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/tickets`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 503);
  server.closeAllConnections?.();
  await new Promise((ok) => server.close(ok));
  await runner.close().catch(() => {});
});

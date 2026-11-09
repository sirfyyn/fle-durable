/**
 * platform/http.js — REST and SSE of the runner's own platform. Same token as every other route.
 *
 *   POST   /api/bus                     {text, source?, id?, topic?, ref?, from?, severity?, data?}   always background class
 *   GET    /api/bus?topic=&after=&limit=&wait=      long-poll: {events, last}
 *   GET    /api/bus/stream?topic=&after=            SSE: event `bus`
 *   GET    /api/bus/state
 *
 *   GET    /api/tickets?status=&type=&assignee=&q=&archived=&limit=&offset=
 *   POST   /api/tickets
 *   GET    /api/tickets/board           columns and counts
 *   GET    /api/tickets/waiting         what waits for the owner
 *   GET    /api/tickets/<id>            with history
 *   PATCH  /api/tickets/<id>
 *   POST   /api/tickets/<id>/comments   {text}
 *   GET    /api/tickets/<id>/history?limit=
 *   POST   /api/tickets/<id>/archive    {reason?}
 *   DELETE /api/tickets/<id>/archive
 *
 *   GET    /api/calendar?from=&to=
 *   POST   /api/calendar
 *   GET    /api/calendar/busy?target=&at=
 *   GET    /api/calendar/<id>
 *   PATCH  /api/calendar/<id>
 *   DELETE /api/calendar/<id>
 *
 * The actor comes from the token, never from the body: otherwise anything with access could answer an approval in the owner's name.
 */
import { actorForToken } from './index.js';
import { BUS_LIMITS, TOPICS } from './bus.js';
import { TicketError } from './tickets.js';

const notFound = (methode, pfad) => new TicketError(404, `unknown route: ${methode} ${pfad}`);
const flag = (value) => value === '1' || value === 'true';

function streamBus({ req, res, url, bus, sseHead, sseSend }) {
  const topic = url.searchParams.get('topic') || TOPICS.INBOX;
  let cursor = Number(url.searchParams.get('after') ?? bus.head(topic)) || 0;
  sseHead(res);
  const flush = () => {
    for (;;) {
      const events = bus.read({ topic, after: cursor, limit: BUS_LIMITS.readMax });
      if (!events.length) return;
      for (const e of events) {
        sseSend(res, 'bus', e);
        cursor = e.seq;
      }
    }
  };
  flush();
  const unsubscribe = bus.subscribe((e) => {
    if (e.topic === topic) queueMicrotask(flush);
  });
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': alive\n\n');
  }, 20_000);
  heartbeat.unref?.();
  req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
}

async function routeBus(a) {
  const { req, res, url, teile, methode, pfad, platform, json, readJson } = a;
  const { bus } = platform;
  if (!teile[2]) {
    if (methode === 'POST') {
      const b = await readJson(req);
      let event;
      try {
        event = bus.publish({
          topic: b.topic,
          id: b.id,
          source: b.source ?? 'webhook',
          text: b.text,
          ref: b.ref,
          from: b.from,
          severity: b.severity,
          data: b.data,
        });
      } catch (fehler) {
        throw new TicketError(400, fehler.message);
      }
      json(res, event.duplicate ? 200 : 202, { ok: true, event });
      return;
    }
    if (methode === 'GET') {
      const out = await bus.wait({
        topic: url.searchParams.get('topic') || TOPICS.INBOX,
        after: url.searchParams.get('after') ?? 0,
        limit: url.searchParams.get('limit') ?? 50,
        waitS: url.searchParams.get('wait') ?? 0,
      });
      json(res, 200, { ok: true, ...out });
      return;
    }
    throw new TicketError(405, 'GET or POST');
  }
  if (teile[2] === 'stream' && methode === 'GET') return streamBus({ ...a, bus });
  if (teile[2] === 'state' && methode === 'GET') {
    json(res, 200, { ok: true, ...bus.state() });
    return;
  }
  throw notFound(methode, pfad);
}

async function routeTickets({ req, res, url, teile, methode, pfad, platform, actor, json, readJson }) {
  const { tickets } = platform;
  const [, , a, b] = teile;
  if (!a) {
    if (methode === 'GET') {
      const p = url.searchParams;
      json(res, 200, {
        ok: true,
        ...tickets.list({
          status: p.get('status') ?? undefined,
          type: p.get('type') ?? undefined,
          assignee: p.get('assignee') ?? undefined,
          q: p.get('q') ?? undefined,
          archived: flag(p.get('archived')),
          limit: p.get('limit') ?? undefined,
          offset: p.get('offset') ?? undefined,
        }),
      });
      return;
    }
    if (methode === 'POST') {
      const out = tickets.create(await readJson(req), { actor });
      json(res, out.created ? 201 : 200, { ok: true, ...out });
      return;
    }
    throw new TicketError(405, 'GET or POST');
  }
  if (a === 'board' && methode === 'GET') {
    json(res, 200, { ok: true, ...tickets.board() });
    return;
  }
  if (a === 'waiting' && methode === 'GET') {
    json(res, 200, { ok: true, ...tickets.waiting() });
    return;
  }
  if (!b) {
    if (methode === 'GET') {
      json(res, 200, { ok: true, ticket: tickets.detail(a) });
      return;
    }
    if (methode === 'PATCH') {
      json(res, 200, { ok: true, ticket: tickets.update(a, await readJson(req), { actor }) });
      return;
    }
    throw new TicketError(405, 'GET or PATCH');
  }
  if (b === 'comments' && methode === 'POST') {
    const body = await readJson(req);
    json(res, 201, { ok: true, entry: tickets.comment(a, body.text, { actor }) });
    return;
  }
  if (b === 'history' && methode === 'GET') {
    json(res, 200, { ok: true, history: tickets.history(a, url.searchParams.get('limit') ?? 100) });
    return;
  }
  if (b === 'archive' && methode === 'POST') {
    const body = await readJson(req);
    json(res, 200, { ok: true, ticket: tickets.archive(a, { actor, reason: body.reason }) });
    return;
  }
  if (b === 'archive' && methode === 'DELETE') {
    json(res, 200, { ok: true, ticket: tickets.unarchive(a, { actor }) });
    return;
  }
  throw notFound(methode, pfad);
}

async function routeCalendar({ req, res, url, teile, methode, pfad, platform, actor, json, readJson }) {
  const { calendar } = platform;
  const a = teile[2];
  if (!a) {
    if (methode === 'GET') {
      json(res, 200, { ok: true, ...calendar.window({ from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined }) });
      return;
    }
    if (methode === 'POST') {
      json(res, 201, { ok: true, entry: calendar.add(await readJson(req), { actor }) });
      return;
    }
    throw new TicketError(405, 'GET or POST');
  }
  if (a === 'busy' && methode === 'GET') {
    json(res, 200, { ok: true, ...calendar.busy(url.searchParams.get('target'), url.searchParams.get('at') ?? undefined) });
    return;
  }
  if (teile[3]) throw notFound(methode, pfad);
  if (methode === 'GET') {
    const entry = calendar.get(a);
    if (!entry) throw new TicketError(404, `no calendar entry ${a}`);
    json(res, 200, { ok: true, entry });
    return;
  }
  if (methode === 'PATCH') {
    json(res, 200, { ok: true, entry: calendar.update(a, await readJson(req), { actor }) });
    return;
  }
  if (methode === 'DELETE') {
    json(res, 200, { ok: true, entry: calendar.remove(a, { actor }) });
    return;
  }
  throw new TicketError(405, 'GET, PATCH or DELETE');
}

export const isPlatformPath = (pfad) => /^\/api\/(bus|tickets|calendar)(\/|$)/.test(pfad);

/** Serve one platform route. `wer` is the name behind the token. */
export async function routePlatform({ req, res, url, pfad, methode, platform, wer, json, readJson, sseHead, sseSend }) {
  if (!platform) throw new TicketError(503, 'the platform is off (platform.an)');
  const teile = pfad.split('/').filter(Boolean);
  const args = { req, res, url, teile, methode, pfad, platform, actor: actorForToken(platform, wer), json, readJson, sseHead, sseSend };
  if (teile[1] === 'bus') return routeBus(args);
  if (teile[1] === 'tickets') return routeTickets(args);
  return routeCalendar(args);
}

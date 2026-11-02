/**
 * agenda.js — events planned at runtime, by the owner (app, API) or by the agent itself (tools agenda_*).
 *
 * "Tomorrow 9:00 look at the build", "every weekday 8:00 summarise my inbox", "in 20 minutes check whether the download
 * finished". Items live in the document `Agenda` (same SQLite file as the conversations). The builtin source `agenda`
 * checks them and puts every due one into the durable queue, idempotent by `agenda:<item>:<due>`; a restart neither
 * loses nor doubles one.
 *
 * Kinds: once {at | in_minutes} · daily {time} · weekly {time, days 1–7, Monday = 1} · interval {every_min ≥ 5}.
 * Times are wall clock in `zone`. Missed while the agent was down: a one-off fires late (the text says so), a repeating
 * item fires once and moves on.
 */
import { randomBytes } from 'node:crypto';
import { CTX, Type, defineDoc, defineTool } from './pi.js';
import { BACKGROUND, OWNER } from './queue.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const AGENDA_LIMITS = Object.freeze({ items: 200, byAgent: 50, minIntervalMin: 5, textMax: 2000, titleMax: 120, history: 50 });
const KINDS = ['once', 'daily', 'weekly', 'interval'];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const Agenda = defineDoc({
  kind: 'fle.agenda',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, items: {}, history: [] }),
  checkpointWhen: () => false,
});

const formats = new Map();
/** The wall clock of a zone as naive ms (as if local time were UTC). */
export function wallClock(ms, zone) {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formats.set(zone, f);
  }
  const t = {};
  for (const p of f.formatToParts(new Date(ms))) t[p.type] = Number(p.value);
  return Date.UTC(t.year, t.month - 1, t.day, t.hour % 24, t.minute, t.second, ms % 1000);
}

/** Wall clock → real ms in `zone`; two rounds settle the offset across a DST change. */
export function wallToUtc(wall, zone) {
  let utc = wall;
  for (let i = 0; i < 2; i += 1) utc = wall - (wallClock(utc, zone) - utc);
  return utc;
}

/** The next due time of an item strictly after `after` (real ms), or null for a finished one-off. */
export function nextDue(item, after, zone) {
  if (item.kind === 'once') return item.at > after ? item.at : null;
  if (item.kind === 'interval') {
    const step = Math.max(AGENDA_LIMITS.minIntervalMin, item.every_min) * MIN;
    const base = Number.isFinite(item.anchor) ? item.anchor : after;
    return base + (Math.floor((after - base) / step) + 1) * step;
  }
  const [, hh, mm] = TIME.exec(item.time);
  const d = new Date(wallClock(after, zone));
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  for (let i = 0; i < 8; i += 1) {
    const wall = midnight + i * DAY + (Number(hh) * 60 + Number(mm)) * MIN;
    const weekday = ((new Date(wall).getUTCDay() + 6) % 7) + 1; // Monday = 1 … Sunday = 7
    if (item.kind === 'weekly' && !item.days.includes(weekday)) continue;
    const utc = wallToUtc(wall, zone);
    if (utc > after) return utc;
  }
  return null;
}

const clip = (s, n) => String(s ?? '').trim().slice(0, n);

/** Check and normalise an item from the app, the API or a tool. Throws a short message the caller can show as is. */
export function normaliseItem(input, { now, zone, by }) {
  const text = clip(input?.text, AGENDA_LIMITS.textMax);
  if (!text) throw new Error('text is required: what should happen');
  const kind = input.kind ?? (input.in_minutes !== undefined || input.at !== undefined ? 'once' : null);
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const item = { kind, title: clip(input.title, AGENDA_LIMITS.titleMax) || clip(text.split('\n')[0], 60), text, by, created: now, paused: false };
  // right of way only for what the owner planned and asked for; the agent never plans owner events
  item.priority = by === 'owner' && input.priority === OWNER ? OWNER : BACKGROUND;
  if (kind === 'once') {
    const at = input.in_minutes !== undefined ? now + Math.round(Number(input.in_minutes) * MIN) : Date.parse(input.at);
    if (!Number.isFinite(at)) throw new Error('once needs at (ISO time) or in_minutes');
    if (at < now - MIN) throw new Error('at lies in the past');
    item.at = at;
  } else if (kind === 'interval') {
    const every = Math.trunc(Number(input.every_min));
    if (!Number.isFinite(every) || every < AGENDA_LIMITS.minIntervalMin) throw new Error(`every_min must be at least ${AGENDA_LIMITS.minIntervalMin}`);
    item.every_min = every;
    item.anchor = now;
  } else {
    if (!TIME.test(String(input.time ?? ''))) throw new Error('time must be HH:MM (24 h)');
    item.time = String(input.time);
    if (kind === 'weekly') {
      const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number))].filter((n) => n >= 1 && n <= 7).sort();
      if (!days.length) throw new Error('weekly needs days, 1 = Monday … 7 = Sunday');
      item.days = days;
    }
  }
  // an interval starts one step from now; a time of day or a moment may be due right now
  item.next = nextDue(item, kind === 'interval' ? now : now - 1, zone);
  return item;
}

const view = (id, it) => ({ id, ...it });
export const newAgendaId = (now) => `a${now.toString(36)}${randomBytes(2).toString('hex')}`;

/** The agenda of one agent: storage, due check, and what the tools, the API and the source call. */
export class AgendaStore {
  /** @param harness () => the open harness (the store exists before the harness is open) */
  constructor({ harness, zone = 'UTC', now = () => Date.now() } = {}) {
    this.harness = harness;
    this.zone = zone;
    this.now = now;
    this.listeners = new Set();
  }

  async #read() {
    const d = (await this.harness().snapshot(Agenda, CTX)) ?? {};
    return { items: d.items ?? {}, history: d.history ?? [] };
  }

  async #change(fn) {
    let out;
    await this.harness().commit(async (tx) => {
      const d = await tx.doc(Agenda);
      d.items ??= {};
      d.history ??= [];
      out = await fn(d);
    }, CTX);
    for (const l of this.listeners) l();
    return out;
  }

  /** Items by next due time (paused and finished last), plus the last fired ones, newest first. */
  async list() {
    const { items, history } = await this.#read();
    const order = (x) => (x.paused || x.next === null ? Infinity : x.next);
    return {
      zone: this.zone,
      items: Object.entries(items).map(([id, it]) => view(id, it)).sort((a, b) => order(a) - order(b)),
      history: [...history].reverse(),
    };
  }

  /** Add an item. With `id` (a replayed tool call) an existing item of that id is returned as it is, with `existed: true`. */
  async add(input, by = 'owner', id = null) {
    if (by !== 'owner' && by !== 'agent') throw new Error('by must be owner or agent');
    const now = this.now();
    const item = normaliseItem(input, { now, zone: this.zone, by });
    id = id ?? newAgendaId(now);
    return this.#change((d) => {
      if (d.items[id]) return { ...view(id, d.items[id]), existed: true };
      const all = Object.values(d.items);
      if (all.length >= AGENDA_LIMITS.items) throw new Error(`the agenda is full (${AGENDA_LIMITS.items} items)`);
      if (by === 'agent' && all.filter((x) => x.by === 'agent').length >= AGENDA_LIMITS.byAgent) {
        throw new Error(`the agent already planned ${AGENDA_LIMITS.byAgent} items; cancel some first`);
      }
      d.items[id] = item;
      return view(id, item);
    });
  }

  /** Remove an item. The agent may only remove what it planned itself; the owner removes anything. */
  async remove(id, by = 'owner') {
    return this.#change((d) => {
      const it = d.items[id];
      if (!it) throw new Error(`no agenda item ${id}`);
      if (by === 'agent' && it.by !== 'agent') throw new Error('this item was planned by the owner; ask them to cancel it');
      delete d.items[id];
      return view(id, it);
    });
  }

  async pause(id, paused = true) {
    return this.#change((d) => {
      const it = d.items[id];
      if (!it) throw new Error(`no agenda item ${id}`);
      it.paused = Boolean(paused);
      if (!it.paused) it.next = nextDue(it, this.now() - 1, this.zone);
      return view(id, it);
    });
  }

  /** The events due now; changes nothing (the source enqueues them, then calls fired()). */
  async due() {
    const now = this.now();
    const { items } = await this.#read();
    return Object.entries(items)
      .filter(([, it]) => !it.paused && it.next !== null && it.next <= now)
      .map(([id, it]) => ({ id, it, event: agendaEvent(id, it, now) }));
  }

  /** After enqueueing: one-offs leave the agenda, repeating items move to their next time. */
  async fired(list) {
    if (!list.length) return;
    const now = this.now();
    await this.#change((d) => {
      for (const { id, it: was } of list) {
        const it = d.items[id];
        if (!it || it.next !== was.next) continue; // changed meanwhile
        d.history.push({ id, title: it.title, due: it.next, fired: now, by: it.by, kind: it.kind });
        it.last = now;
        it.next = it.kind === 'once' ? null : nextDue(it, now, this.zone);
        if (it.kind === 'once') delete d.items[id];
      }
      if (d.history.length > AGENDA_LIMITS.history) d.history.splice(0, d.history.length - AGENDA_LIMITS.history);
    });
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** The queue entry of a due item; unique per item and due time, so a restart cannot enqueue it twice. */
export function agendaEvent(id, it, now) {
  const late = now - it.next > 5 * MIN ? ` It was due ${new Date(it.next).toISOString()} and fires late.` : '';
  const who = it.by === 'agent' ? 'You planned this yourself.' : 'Your owner planned this.';
  return {
    id: `agenda:${id}:${it.next}`,
    text: `Agenda: ${it.title}\n\n${it.text}\n\n${who}${late}`,
    source: 'agenda',
    from: it.by === 'agent' ? 'agent' : 'owner',
    ref: `agenda-${id}`,
    priority: it.priority === OWNER ? OWNER : BACKGROUND,
  };
}

/** The builtin source `agenda`: checks every `check_s` seconds and enqueues what is due. */
export function agendaSource({ store, enqueue, options = {}, log = console }) {
  const everyMs = Math.max(1, Number(options.check_s ?? 15)) * 1000;
  let timer = null;
  let running = false;
  let last = null;
  let error = null;
  const round = async () => {
    try {
      const list = await store.due();
      for (const x of list) await enqueue(x.event);
      await store.fired(list);
      last = Date.now();
      error = null;
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 200);
      log.error?.(`[agenda] ${error}`);
    }
  };
  const loop = async () => {
    if (!running) return;
    await round();
    if (running) {
      timer = setTimeout(loop, everyMs);
      timer.unref?.();
    }
  };
  let unsubscribe = null;
  return {
    start() {
      if (running) return;
      running = true;
      // a change (a new item due in a minute) should not wait for a full round
      unsubscribe = store.onChange(() => {
        if (!running) return;
        clearTimeout(timer);
        timer = setTimeout(loop, 200);
        timer.unref?.();
      });
      void loop();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      unsubscribe?.();
    },
    state: () => ({ running, every_s: everyMs / 1000, last, error }),
  };
}

const result = (text, details) => ({ output: [{ type: 'text', text: String(text) }], ...(details ? { details } : {}) });
const when = (ms, zone) => (ms === null || ms === undefined ? '—' : new Date(ms).toLocaleString('en-GB', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }));

/** The agent's tools: plan, list and cancel agenda items. `store` is a function; the store comes with the harness. */
export function agendaTools(store) {
  const plan = defineTool({
    name: 'agenda_plan',
    description:
      'Plan an event for later: you get it back as a message from the source "agenda" when it is due, even after a restart. ' +
      'Use it to follow up on something, to check a result later, or for a recurring duty the owner asked for. ' +
      'kind once (at: ISO time, or in_minutes), daily (time HH:MM), weekly (time, days 1 = Monday … 7 = Sunday), interval (every_min, at least 5). ' +
      'text is the instruction to your future self: say what to do and what to look at. The owner sees every item.',
    parameters: Type.Object({
      kind: Type.Union([Type.Literal('once'), Type.Literal('daily'), Type.Literal('weekly'), Type.Literal('interval')]),
      text: Type.String({ minLength: 1, maxLength: AGENDA_LIMITS.textMax }),
      title: Type.Optional(Type.String({ maxLength: AGENDA_LIMITS.titleMax })),
      at: Type.Optional(Type.String({ description: 'ISO 8601 time, for once' })),
      in_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 60 * 24 * 365 })),
      time: Type.Optional(Type.String({ description: 'HH:MM, for daily and weekly' })),
      days: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }))),
      every_min: Type.Optional(Type.Integer({ minimum: AGENDA_LIMITS.minIntervalMin })),
    }),
    // a replayed call after a crash finds the item it already planned
    replay: 'safe',
    execute: async (p, api, context) => {
      const s = store();
      const candidate = newAgendaId(s.now());
      const id = typeof api?.memo === 'function' ? await api.memo('agenda_id', candidate, context) : candidate;
      const it = await s.add(p, 'agent', id);
      return result(`${it.existed ? 'Already planned' : 'Planned'} ${it.id} “${it.title}”, next ${when(it.next, s.zone)}.`, { item: it });
    },
  });
  const list = defineTool({
    name: 'agenda_list',
    description: 'List the agenda: every planned item with its next time and who planned it (owner or you).',
    parameters: Type.Object({}),
    replay: 'safe',
    execute: async () => {
      const s = store();
      const { items } = await s.list();
      if (!items.length) return result('The agenda is empty.');
      const lines = items.map((x) => `${x.id}  ${x.paused ? 'paused' : when(x.next, s.zone)}  ${x.kind}  by ${x.by}  “${x.title}”`);
      return result(lines.join('\n'), { items });
    },
  });
  const cancel = defineTool({
    name: 'agenda_cancel',
    description: 'Cancel an agenda item you planned yourself (items of the owner stay; ask them instead).',
    parameters: Type.Object({ id: Type.String({ minLength: 2, maxLength: 40 }) }),
    replay: 'safe',
    execute: async (p) => {
      const it = await store().remove(p.id, 'agent');
      return result(`Cancelled ${p.id} “${it.title}”.`);
    },
  });
  return [plan, list, cancel];
}

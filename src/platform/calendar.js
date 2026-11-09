/**
 * platform/calendar.js — the runner's own calendar: the time axis next to the tickets, modelled on persona-itsm/kalender.py.
 *
 * A ticket locks the what, the calendar the when. An entry can be exclusive for a target (`exklusiv: "hauptserver"`): a guard asks
 * busy("hauptserver") and holds back. That question is what makes a calendar act instead of just show.
 *
 * Rules from there:
 *   - moving an entry keeps its duration: only `from` means "an hour later", from and to together mean re-laying it
 *   - a source that cannot be read is named as unreachable, never shown as empty
 *   - when the store cannot be read, busy() answers `unknown`, not `free`: a guard that runs on a read error is worse than one that waits
 *
 * Linked calendars come in through bridges (platform/bridges.js) and land here as entries with their origin.
 * What is due with a reminder goes into the agent's inbox, once per entry and start time.
 */
import { randomBytes } from 'node:crypto';
import { TOPICS } from './bus.js';
import { TicketError } from './tickets.js';
import { tx } from '../i18n.js';

export const CALENDAR_LIMITS = Object.freeze({ title: 200, description: 4000, location: 200, windowMaxDays: 400, reminderMaxMin: 7 * 24 * 60 });
const HOUR = 3600_000;

const MIGRATIONS = {
  'calendar.1': `
    CREATE TABLE calendar_entries (
      id TEXT PRIMARY KEY,
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      exklusiv TEXT,
      updated INTEGER NOT NULL,
      doc TEXT NOT NULL
    );
    CREATE INDEX calendar_start ON calendar_entries (start);
    CREATE INDEX calendar_exklusiv ON calendar_entries (exklusiv) WHERE exklusiv IS NOT NULL;
    CREATE TABLE calendar_requests (id TEXT PRIMARY KEY, result TEXT NOT NULL, t INTEGER NOT NULL);
  `,
};

function time(value, field) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) throw new TicketError(400, `${field} is no time; use ISO 8601`);
  return ms;
}

const iso = (ms) => new Date(ms).toISOString();

export class Calendar {
  constructor({ store, bus = null, actor = (name) => String(name ?? 'system').toLowerCase(), now = () => Date.now() } = {}) {
    this.store = store;
    this.bus = bus;
    this.actor = actor;
    this.now = now;
    /** Filled by the bridges: () => [{ source, reason }]. */
    this.unreachable = () => [];
    store.migrate(MIGRATIONS);
    const db = store.db;
    this.q = {
      get: db.prepare('SELECT doc FROM calendar_entries WHERE id = ?'),
      put: db.prepare('INSERT INTO calendar_entries (id, start, end, exklusiv, updated, doc) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET start = excluded.start, end = excluded.end, exklusiv = excluded.exklusiv, updated = excluded.updated, doc = excluded.doc'),
      del: db.prepare('DELETE FROM calendar_entries WHERE id = ?'),
      window: db.prepare('SELECT doc FROM calendar_entries WHERE start <= ? AND end >= ? ORDER BY start, id'),
      busy: db.prepare('SELECT doc FROM calendar_entries WHERE exklusiv = ? AND start <= ? AND end >= ? ORDER BY start LIMIT 1'),
      remind: db.prepare('SELECT doc FROM calendar_entries WHERE start > ? AND start <= ? ORDER BY start'),
      requestGet: db.prepare('SELECT result FROM calendar_requests WHERE id = ?'),
      requestSet: db.prepare('INSERT INTO calendar_requests (id, result, t) VALUES (?, ?, ?)'),
    };
  }

  #write(e, start, end) {
    this.q.put.run(e.id, start, end, e.exklusiv || null, this.now(), JSON.stringify(e));
  }

  #announce(id, event, actor, text) {
    this.bus?.publish({
      topic: TOPICS.CALENDAR,
      id: `${id}:${event}:${this.now()}:${Math.random().toString(36).slice(2, 8)}`,
      source: 'calendar',
      from: actor,
      ref: id,
      text: `${event}: ${String(text).slice(0, 300)}`,
      data: { entry: id, event, actor },
    });
  }

  /** A repeated request (a replayed tool call) gets its first answer back. */
  once(requestId, fn) {
    if (!requestId) return fn();
    return this.store.transaction(() => {
      const known = this.q.requestGet.get(String(requestId));
      if (known) return JSON.parse(known.result);
      const out = fn();
      this.q.requestSet.run(String(requestId), JSON.stringify(out ?? null), this.now());
      return out;
    });
  }

  #fields(input, entry) {
    if (input.title !== undefined) entry.title = String(input.title).trim().slice(0, CALENDAR_LIMITS.title) || '(no title)';
    if (input.description !== undefined) entry.description = String(input.description).slice(0, CALENDAR_LIMITS.description);
    if (input.location !== undefined) entry.location = String(input.location).slice(0, CALENDAR_LIMITS.location);
    if (input.ticket !== undefined) entry.ticket = input.ticket ? String(input.ticket).slice(0, 32) : null;
    if (input.exklusiv !== undefined) entry.exklusiv = input.exklusiv ? String(input.exklusiv).trim().slice(0, 64) : null;
    if (input.all_day !== undefined) entry.all_day = Boolean(input.all_day);
    if (input.remind_min !== undefined) {
      if (input.remind_min === null || input.remind_min === '') entry.remind_min = null;
      else {
        const n = Math.trunc(Number(input.remind_min));
        if (!Number.isFinite(n) || n < 0 || n > CALENDAR_LIMITS.reminderMaxMin) throw new TicketError(400, `remind_min must be between 0 and ${CALENDAR_LIMITS.reminderMaxMin}`);
        entry.remind_min = n;
      }
    }
    return entry;
  }

  /** `from` is required: without a time it is a ticket, not an entry. Without `to` it lasts an hour. */
  add(input = {}, { actor, origin = null } = {}) {
    if (!input.from) throw new TicketError(400, '`from` is missing: an entry without a start is a ticket');
    const who = this.actor(actor ?? input.actor);
    const start = time(input.from, 'from');
    const end = input.to ? time(input.to, 'to') : start + HOUR;
    if (end <= start) throw new TicketError(400, '`to` does not lie after `from`');
    const id = `k${randomBytes(6).toString('hex')}`;
    const entry = this.#fields(input, {
      id,
      title: '(no title)',
      description: '',
      location: '',
      from: iso(start),
      to: iso(end),
      all_day: false,
      actor: who,
      source: origin ?? 'planned',
      ticket: null,
      exklusiv: null,
      remind_min: null,
      created_at: iso(this.now()),
      updated_at: iso(this.now()),
    });
    return this.store.transaction(() => {
      this.#write(entry, start, end);
      this.#announce(id, 'created', who, entry.title);
      return entry;
    });
  }

  get(id) {
    const r = this.q.get.get(String(id));
    return r ? JSON.parse(r.doc) : null;
  }

  /** Only `from` moves the entry and keeps its length; `from` and `to` together re-lay it. Both end up under the same check. */
  update(id, input = {}, { actor } = {}) {
    return this.store.transaction(() => {
      const entry = this.get(id);
      if (!entry) throw new TicketError(404, `no calendar entry ${id}`);
      const who = this.actor(actor ?? input.actor);
      let start = Date.parse(entry.from);
      let end = Date.parse(entry.to);
      if (input.from !== undefined && input.to === undefined) {
        const moved = time(input.from, 'from');
        end = moved + (end - start);
        start = moved;
      } else {
        if (input.from !== undefined) start = time(input.from, 'from');
        if (input.to !== undefined) end = time(input.to, 'to');
      }
      if (end <= start) throw new TicketError(400, '`to` does not lie after `from`');
      this.#fields(input, entry);
      entry.from = iso(start);
      entry.to = iso(end);
      entry.updated_at = iso(this.now());
      this.#write(entry, start, end);
      this.#announce(id, 'updated', who, entry.title);
      return entry;
    });
  }

  remove(id, { actor } = {}) {
    return this.store.transaction(() => {
      const entry = this.get(id);
      if (!entry) throw new TicketError(404, `no calendar entry ${id}`);
      const who = this.actor(actor);
      this.q.del.run(String(id));
      this.#announce(id, 'removed', who, entry.title);
      return entry;
    });
  }

  /** All entries in a window, and every source that could not be read. Empty only means empty when `unreachable` is empty too. */
  window({ from, to } = {}) {
    const start = from ? time(from, 'from') : this.now();
    const end = to ? time(to, 'to') : start + 7 * 24 * HOUR;
    if (end <= start) throw new TicketError(400, '`to` does not lie after `from`');
    if (end - start > CALENDAR_LIMITS.windowMaxDays * 24 * HOUR) throw new TicketError(400, `the window is limited to ${CALENDAR_LIMITS.windowMaxDays} days`);
    const unreachable = this.unreachable();
    return {
      from: iso(start),
      to: iso(end),
      entries: this.q.window.all(end, start).map((r) => JSON.parse(r.doc)),
      unreachable,
      complete: unreachable.length === 0,
    };
  }

  /** Is this target exclusively taken right now? On a read error `unknown`, never `free`. */
  busy(target, at = this.now()) {
    const name = String(target ?? '').trim();
    if (!name) throw new TicketError(400, 'target is required');
    try {
      const t = time(at, 'at');
      const row = this.q.busy.get(name, t, t);
      return { target: name, busy: Boolean(row), unknown: false, by: row ? JSON.parse(row.doc) : null };
    } catch (fehler) {
      if (fehler instanceof TicketError) throw fehler;
      return { target: name, busy: null, unknown: true, reason: `store not readable: ${String(fehler?.message ?? fehler).slice(0, 80)}` };
    }
  }

  /** Reminders that are due: each once per entry and start, by its event id. A moved entry reminds again. */
  remind() {
    const now = this.now();
    let sent = 0;
    for (const row of this.q.remind.all(now, now + CALENDAR_LIMITS.reminderMaxMin * 60_000)) {
      const e = JSON.parse(row.doc);
      if (e.remind_min === null || e.remind_min === undefined) continue;
      const start = Date.parse(e.from);
      if (start - e.remind_min * 60_000 > now) continue;
      const out = this.bus?.publish({
        topic: TOPICS.INBOX,
        id: `calendar:${e.id}:${start}`,
        source: 'calendar',
        ref: e.ticket ?? e.id,
        text: tx(
          `Termin „${e.title}“ beginnt ${e.from}${e.location ? ` (${e.location})` : ''}.${e.description ? `\n\n${e.description}` : ''}`,
          `Calendar entry „${e.title}“ starts ${e.from}${e.location ? ` (${e.location})` : ''}.${e.description ? `\n\n${e.description}` : ''}`,
        ),
      });
      if (out && !out.duplicate) sent += 1;
    }
    return sent;
  }
}

/** The clock of the calendar: checks for due reminders. A failed round never takes the runner down. */
export function calendarClock({ calendar, everyS = 30, log = console }) {
  let timer = null;
  let last = null;
  let error = null;
  const round = () => {
    try {
      last = { at: Date.now(), sent: calendar.remind() };
      error = null;
    } catch (fehler) {
      error = String(fehler?.message ?? fehler).slice(0, 200);
      log.error?.(`[calendar] ${error}`);
    }
  };
  return {
    inner: calendar,
    start() {
      if (timer) return;
      round();
      timer = setInterval(round, Math.max(1, everyS) * 1000);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    state: () => ({ running: Boolean(timer), every_s: everyS, last, error }),
  };
}

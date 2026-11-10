/**
 * platform/bridges.js — calendars from outside. The program that can read them (FLE Link) pushes what it read; the entries
 * here are a mirror, so the next sync replaces them. A source that could not be read is named as unreachable and keeps its
 * last entries: empty only ever means empty.
 */
import { createHash } from 'node:crypto';
import { TOPICS } from './bus.js';
import { CALENDAR_LIMITS } from './calendar.js';
import { TicketError } from './tickets.js';

const SOURCE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_ENTRIES = 5000;
const text = (v, n) => String(v ?? '').slice(0, n);

export class CalendarBridges {
  constructor({ calendar, store, bus = null, now = () => Date.now() }) {
    this.calendar = calendar;
    this.store = store;
    this.bus = bus;
    this.now = now;
    this.reasons = new Map();
    calendar.unreachable = () => [...this.reasons].map(([source, reason]) => ({ source, reason }));
    this.inWindow = store.db.prepare('SELECT doc FROM calendar_entries WHERE id LIKE ? AND start <= ? AND end >= ?');
  }

  #entry(source, e, old) {
    const start = Date.parse(e.from);
    const end = Date.parse(e.to);
    if (!e.id || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const id = `ext-${source}-${createHash('sha256').update(String(e.id)).digest('hex').slice(0, 16)}`;
    const stamp = new Date(this.now()).toISOString();
    return {
      start,
      end,
      doc: {
        id,
        title: text(e.title, CALENDAR_LIMITS.title) || '(no title)',
        description: text(e.description, CALENDAR_LIMITS.description),
        location: text(e.location, CALENDAR_LIMITS.location),
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        all_day: Boolean(e.all_day),
        actor: source,
        source,
        ticket: null,
        exklusiv: null,
        remind_min: null,
        created_at: old?.created_at ?? stamp,
        updated_at: stamp,
      },
    };
  }

  /** `{from, to, entries}` is everything the source has in that window; `{reason}` says it could not be read. */
  sync(source, { from, to, entries, reason } = {}) {
    if (!SOURCE.test(source)) throw new TicketError(400, '`source` is not a valid name');
    if (reason) {
      this.reasons.set(source, text(reason, 300));
      return { source, reachable: false };
    }
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new TicketError(400, '`from` and `to` are needed');
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new TicketError(400, `\`entries\`: a list of at most ${MAX_ENTRIES}`);
    this.reasons.delete(source);
    return this.store.transaction(() => {
      const known = new Map(this.inWindow.all(`ext-${source}-%`, end, start).map((r) => { const d = JSON.parse(r.doc); return [d.id, d]; }));
      let added = 0;
      let changed = 0;
      const seen = new Set();
      for (const e of entries) {
        const id = `ext-${source}-${createHash('sha256').update(String(e?.id)).digest('hex').slice(0, 16)}`;
        const made = this.#entry(source, e ?? {}, known.get(id));
        if (!made || seen.has(made.doc.id)) continue;
        seen.add(made.doc.id);
        const old = known.get(made.doc.id) ?? this.calendar.get(made.doc.id);
        const same = old && ['title', 'description', 'location', 'from', 'to', 'all_day'].every((k) => old[k] === made.doc[k]);
        if (same) continue;
        if (old) changed += 1;
        else added += 1;
        this.calendar.q.put.run(made.doc.id, made.start, made.end, null, this.now(), JSON.stringify(made.doc));
      }
      let removed = 0;
      for (const id of known.keys()) {
        if (seen.has(id)) continue;
        this.calendar.q.del.run(id);
        removed += 1;
      }
      if (added + changed + removed > 0) {
        this.bus?.publish({
          topic: TOPICS.CALENDAR,
          id: `${source}:sync:${this.now()}`,
          source: 'calendar',
          from: source,
          text: `${source}: ${added} new, ${changed} changed, ${removed} gone`,
          data: { source, added, changed, removed },
        });
      }
      return { source, reachable: true, added, changed, removed };
    });
  }
}

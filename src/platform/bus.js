/**
 * platform/bus.js — the runner's own event bus: a durable log in SQLite, no Redis.
 *
 * Topics are append-only with a rising `seq`. A consumer keeps its own cursor and acknowledges what it has handled, so delivery
 * is at-least-once and every consumer must be idempotent by event id. `id` is unique per topic: publishing the same id twice
 * returns the first event with `duplicate: true`.
 *
 * Fields follow the FYOS agent inbox (mcp_hub/plugins/_agenteneingang.py), so a bridge can map them 1:1. The rule from there holds
 * here too: a background source cannot promote itself to the owner class; only trusted callers in this process may pass `owner`.
 */
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CLASS, OWNER_CLASS } from '../ports/contracts.js';
import { inboxSeverity } from './envelope.js';

export const BUS_LIMITS = Object.freeze({ textMax: 8000, refMax: 120, fromMax: 64, idMax: 160, readMax: 200, waitMaxS: 25, keepPerTopic: 50_000 });
export const TOPICS = Object.freeze({ INBOX: 'inbox', OUTBOX: 'outbox', TICKETS: 'tickets', CALENDAR: 'calendar', BRIDGES: 'bridges' });
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
// Control characters go, except line break and tab in the text.
const MULTILINE = /[\x00-\x08\x0b-\x1f\x7f]/g;
const ONELINE = /[\x00-\x1f\x7f]/g;

const MIGRATIONS = {
  'bus.1': `
    CREATE TABLE bus_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      id TEXT NOT NULL,
      t INTEGER NOT NULL,
      source TEXT NOT NULL,
      class TEXT NOT NULL,
      text TEXT NOT NULL,
      ref TEXT,
      sender TEXT,
      severity TEXT,
      workspace TEXT,
      data TEXT,
      UNIQUE (topic, id)
    );
    CREATE INDEX bus_events_topic_seq ON bus_events (topic, seq);
    CREATE TABLE bus_cursors (
      consumer TEXT NOT NULL,
      topic TEXT NOT NULL,
      seq INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      PRIMARY KEY (consumer, topic)
    );
  `,
};

const row = (r) => ({
  seq: r.seq,
  topic: r.topic,
  id: r.id,
  t: r.t,
  source: r.source,
  class: r.class,
  text: r.text,
  ref: r.ref ?? null,
  from: r.sender ?? null,
  severity: r.severity ?? null,
  workspace: r.workspace ?? null,
  data: r.data ? JSON.parse(r.data) : null,
});

const line = (value, max) => String(value ?? '').replace(ONELINE, '').trim().slice(0, max) || null;

export class Bus {
  constructor({ store, now = () => Date.now(), keepPerTopic = BUS_LIMITS.keepPerTopic } = {}) {
    this.store = store;
    this.now = now;
    this.keepPerTopic = keepPerTopic;
    this.listeners = new Set();
    store.migrate(MIGRATIONS);
    const db = store.db;
    this.q = {
      byId: db.prepare('SELECT * FROM bus_events WHERE topic = ? AND id = ?'),
      insert: db.prepare(
        'INSERT INTO bus_events (topic, id, t, source, class, text, ref, sender, severity, workspace, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      read: db.prepare('SELECT * FROM bus_events WHERE topic = ? AND seq > ? ORDER BY seq LIMIT ?'),
      head: db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM bus_events WHERE topic = ?'),
      count: db.prepare('SELECT topic, COUNT(*) AS n, MAX(seq) AS head FROM bus_events GROUP BY topic'),
      cursor: db.prepare('SELECT seq FROM bus_cursors WHERE consumer = ? AND topic = ?'),
      cursors: db.prepare('SELECT consumer, topic, seq, updated FROM bus_cursors ORDER BY consumer, topic'),
      ack: db.prepare(
        'INSERT INTO bus_cursors (consumer, topic, seq, updated) VALUES (?, ?, ?, ?) ON CONFLICT (consumer, topic) DO UPDATE SET seq = MAX(seq, excluded.seq), updated = excluded.updated',
      ),
      slowest: db.prepare('SELECT MIN(seq) AS seq FROM bus_cursors WHERE topic = ?'),
      trim: db.prepare('DELETE FROM bus_events WHERE topic = ? AND seq <= ?'),
    };
  }

  /**
   * Publish one event. `owner: true` is for callers inside this process that know the owner wrote it (chat); nothing that comes
   * from outside passes it. Throws on invalid input, with a message that can be shown as is.
   */
  publish(event, { owner = false } = {}) {
    const topic = String(event?.topic ?? TOPICS.INBOX);
    if (!NAME.test(topic)) throw new Error('topic: lower case letters, digits, . _ : -');
    const source = String(event?.source ?? '');
    if (!NAME.test(source)) throw new Error('source is required: lower case letters, digits, . _ : -');
    const text = String(event?.text ?? '').replace(MULTILINE, '').trim();
    if (!text) throw new Error('text is required');
    if (text.length > BUS_LIMITS.textMax) throw new Error(`text: at most ${BUS_LIMITS.textMax} characters`);
    const severity = event?.severity ? String(event.severity) : null;
    if (severity && !SEVERITIES.includes(severity)) throw new Error(`severity: one of ${SEVERITIES.join(', ')}`);
    const id = line(event?.id, BUS_LIMITS.idMax) ?? randomUUID();

    const known = this.q.byId.get(topic, id);
    if (known) return { ...row(known), duplicate: true };

    const klass = owner ? OWNER_CLASS : BACKGROUND_CLASS;
    const t = this.now();
    const { lastInsertRowid } = this.q.insert.run(
      topic,
      id,
      t,
      source,
      klass,
      text,
      line(event?.ref, BUS_LIMITS.refMax),
      line(event?.from, BUS_LIMITS.fromMax),
      severity,
      line(event?.workspace, BUS_LIMITS.fromMax),
      event?.data === undefined || event?.data === null ? null : JSON.stringify(event.data),
    );
    const seq = Number(lastInsertRowid);
    const out = row(this.q.byId.get(topic, id));
    this.#trim(topic, seq);
    for (const listener of this.listeners) {
      try {
        listener(out);
      } catch (fehler) {
        console.error(`[bus] listener: ${fehler?.message ?? fehler}`);
      }
    }
    return { ...out, duplicate: false };
  }

  /** Keep the log bounded, but never drop what a consumer has not acknowledged yet. */
  #trim(topic, seq) {
    if (seq % 1000 !== 0) return;
    let limit = seq - this.keepPerTopic;
    const slowest = this.q.slowest.get(topic)?.seq;
    if (slowest !== null && slowest !== undefined) limit = Math.min(limit, slowest);
    if (limit > 0) this.q.trim.run(topic, limit);
  }

  read({ topic = TOPICS.INBOX, after = 0, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 50, BUS_LIMITS.readMax));
    return this.q.read.all(topic, Number(after) || 0, n).map(row);
  }

  head(topic = TOPICS.INBOX) {
    return Number(this.q.head.get(topic).seq);
  }

  /**
   * Long-poll: what comes after `after`, waiting up to `waitS` seconds for the first event. Same shape as the hub inbox:
   * `{ events, last }`, where `last` is the position for the next call.
   */
  async wait({ topic = TOPICS.INBOX, after = 0, limit = 50, waitS = 0, signal } = {}) {
    const from = Number(after) || 0;
    let events = this.read({ topic, after: from, limit });
    const ms = Math.max(0, Math.min(Number(waitS) || 0, BUS_LIMITS.waitMaxS)) * 1000;
    if (!events.length && ms > 0 && !signal?.aborted) {
      await new Promise((done) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          this.listeners.delete(listener);
          done();
        };
        const listener = (e) => {
          if (e.topic === topic) finish();
        };
        const timer = setTimeout(finish, ms);
        timer.unref?.();
        signal?.addEventListener('abort', finish, { once: true });
        this.listeners.add(listener);
      });
      events = this.read({ topic, after: from, limit });
    }
    return { events, last: events.length ? events.at(-1).seq : from };
  }

  /** In-process: called for every new event. Returns the unsubscribe function. */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  cursor(consumer, topic = TOPICS.INBOX) {
    return Number(this.q.cursor.get(consumer, topic)?.seq ?? 0);
  }

  /** A consumer has handled everything up to `seq`. The cursor only moves forward. */
  ack(consumer, seq, topic = TOPICS.INBOX) {
    this.q.ack.run(consumer, topic, Number(seq) || 0, this.now());
  }

  state() {
    return { topics: this.q.count.all().map((r) => ({ topic: r.topic, events: r.n, head: r.head })), cursors: this.q.cursors.all().map((r) => ({ ...r })) };
  }
}

/**
 * The port `sources` on top of the bus: everything on the inbox topic goes into the agent's durable queue.
 * The queue entry id is `bus:<id>`, so a crash between enqueueing and acknowledging repeats the hand-over without a second turn.
 */
export function busSource({ bus, enqueue, consumer = 'agent', topic = TOPICS.INBOX, log = console, retryMs = 2000 }) {
  let running = false;
  let abort = null;
  let handled = 0;
  let error = null;
  const pump = async () => {
    while (running) {
      abort = new AbortController();
      try {
        const { events } = await bus.wait({ topic, after: bus.cursor(consumer, topic), waitS: 20, signal: abort.signal });
        for (const e of events) {
          await enqueue({
            id: `bus:${e.id}`,
            text: e.text,
            quelle: e.source,
            von: e.from ?? e.source,
            bezug: e.ref,
            klasse: e.class,
            // The queue speaks the inbox's words; the reflex `alarm-hoch` would never see `high`.
            schwere: inboxSeverity(e.severity),
            arbeitsbereich: e.workspace,
          });
          bus.ack(consumer, e.seq, topic);
          handled += 1;
        }
        error = null;
      } catch (fehler) {
        error = String(fehler?.message ?? fehler).slice(0, 200);
        log.error?.(`[bus] ${error}`);
        await new Promise((done) => {
          const timer = setTimeout(done, retryMs);
          timer.unref?.();
        });
      }
    }
  };
  let loop = null;
  return {
    inner: bus,
    start() {
      if (running) return;
      running = true;
      loop = pump();
    },
    async stop() {
      running = false;
      abort?.abort();
      await loop;
    },
    state: () => ({ running, handled, error, cursor: bus.cursor(consumer, topic), head: bus.head(topic) }),
  };
}

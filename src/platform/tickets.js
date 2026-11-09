/**
 * platform/tickets.js — the runner's own ticket system, modelled on the FYOS ITSM (persona-itsm/main.py).
 *
 * Field names and rules are the ones of the FYOS ITSM on purpose: a bridge can then sync both systems 1:1 without losing anything.
 * Rules taken over, each with its reason in persona-itsm:
 *   - actors come from a registry, free text is refused; `closed` is set and left only by a human
 *   - plans (CHG, VOR) by anyone but the owner start in `triage`: they wait for a decision, not for work
 *   - `triage` always has a way back: a follow-up date (default 14 days), and the sweep pulls it to `new` when due
 *   - `expected_status`: the first valid answer to an approval wins, the second gets a conflict
 *   - a closing note that hands work on is an approval question, not a result (resolved → waiting_approval)
 *   - a master closes only when all children are done, and resolves only with a reason and a sample child
 *   - the same fingerprint counts on the open ticket, and for 24 h after closing on the old one (no flood, no reopening)
 *   - an approval unanswered for 72 h goes back to `new`: no answer is neither yes nor no
 *   - text is never cut silently; history is append-only
 *
 * Own ids carry a P (`INC-P12`), so they can never collide with the plain numbers of a linked system.
 * Not taken over, they belong to FYOS: topology map, component registry, error watcher, pipelines, global hold.
 */
import { BACKGROUND_CLASS } from '../ports/contracts.js';
import { schwaerzenText } from '../schwaerzen.js';
import { tx } from '../i18n.js';
import { TOPICS } from './bus.js';

export const TICKET_TYPES = Object.freeze(['INC', 'PRB', 'CHG', 'VOR']);
const PLAN_TYPES = ['CHG', 'VOR'];
export const STATUSES = Object.freeze(['new', 'triage', 'in_progress', 'waiting_approval', 'resolved', 'closed']);
export const OPEN_STATUSES = Object.freeze(['new', 'triage', 'in_progress', 'waiting_approval']);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
const DONE = ['resolved', 'closed'];
export const TICKET_LIMITS = Object.freeze({
  title: 300,
  description: 4000,
  detail: 20_000,
  fingerprint: 200,
  links: 500,
  waitingFor: 200,
  masterReason: 2000,
  followUpDefaultDays: 14,
  followUpMaxDays: 366,
  approvalHours: 72,
  flapHours: 24,
  contextMax: 600,
});
const DAY = 86_400_000;
const ID = /^(INC|PRB|CHG|VOR)-[A-Za-z0-9]{1,16}$/;

/** An error the API can show as it is. `status` is the HTTP status. */
export class TicketError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'TicketError';
    this.status = status;
  }
}

const MIGRATIONS = {
  'tickets.1': `
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      assignee TEXT NOT NULL,
      fingerprint TEXT,
      master TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL,
      doc TEXT NOT NULL
    );
    CREATE INDEX tickets_status ON tickets (archived, status, updated);
    CREATE INDEX tickets_fingerprint ON tickets (fingerprint) WHERE fingerprint IS NOT NULL;
    CREATE INDEX tickets_master ON tickets (master) WHERE master IS NOT NULL;
    CREATE TABLE ticket_history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket TEXT NOT NULL,
      ts TEXT NOT NULL,
      event TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      origin TEXT
    );
    CREATE INDEX ticket_history_ticket ON ticket_history (ticket, seq);
    CREATE TABLE ticket_flap (
      fingerprint TEXT PRIMARY KEY,
      ticket TEXT NOT NULL,
      until INTEGER NOT NULL
    );
    CREATE TABLE ticket_seq (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
    INSERT INTO ticket_seq (name, n) VALUES ('ticket', 0);
    CREATE TABLE ticket_requests (id TEXT PRIMARY KEY, result TEXT NOT NULL, t INTEGER NOT NULL);
  `,
};

/** Cut with a visible mark: a cut nobody can see is a lie about the content. */
export function cut(text, limit = TICKET_LIMITS.detail) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  const mark = `\n\n[…cut: ${limit} of ${s.length} characters stored]`;
  return s.slice(0, limit - mark.length) + mark;
}

function normaliseLinks(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(parts.map((x) => String(x).trim()).filter(Boolean))];
}

// ── Follow-up date ─────────────────────────────────────────────────────────────────────────────────
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE = /^\+(\d{1,3})([tdwm])$/i;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** `2026-09-16`, or short `+14t`, `+14d`, `+2w`, `+3m` (a month is 30 days). Empty → ''. Refuses the past and “practically never”. */
export function parseFollowUp(value, today) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  const max = TICKET_LIMITS.followUpMaxDays;
  const relative = RELATIVE.exec(s);
  if (relative) {
    const days = { t: 1, d: 1, w: 7, m: 30 }[relative[2].toLowerCase()] * Number(relative[1]);
    if (days < 1) throw new TicketError(422, 'wiedervorlage: name a distance of at least one day');
    if (days > max) throw new TicketError(422, `wiedervorlage: ${s} is ${days} days, at most ${max} are allowed`);
    return addDays(today, days);
  }
  if (!ISO_DAY.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new TicketError(422, `wiedervorlage: ${JSON.stringify(s)} is no date; use YYYY-MM-DD or +14t, +2w, +3m`);
  }
  if (s <= today) throw new TicketError(422, `wiedervorlage: ${s} is not in the future (today is ${today})`);
  if (Date.parse(`${s}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`) > max * DAY) {
    throw new TicketError(422, `wiedervorlage: ${s} is more than ${max} days away`);
  }
  return s;
}

/** The date and its origin for a ticket going to triage: what was asked for, else a still valid one, else the default. */
export function followUpForTriage(existing, wanted, today) {
  if (wanted) return { date: parseFollowUp(wanted, today), origin: 'gesetzt' };
  if (existing && ISO_DAY.test(String(existing)) && String(existing) > today) return { date: String(existing), origin: 'gesetzt' };
  return { date: addDays(today, TICKET_LIMITS.followUpDefaultDays), origin: 'standard' };
}

// ── Handing work on ────────────────────────────────────────────────────────────────────────────────
/** Is this closing note really a hand-over? Phrases, not single words: a false alarm steals the owner's attention. */
export function handsOver(text, names = []) {
  const s = String(text ?? '');
  if (!s) return null;
  const who = names.map((n) => String(n).replace(/[^a-z0-9_-]/gi, '')).filter(Boolean).join('|');
  const patterns = [
    ...(who
      ? [
          `@(?:${who})\\b`,
          `\\b(?:an|f(?:ue|ü)r|von|for|to)\\s+(?:${who})\\b`,
          `\\b(?:${who})\\s+(?:muss|sollte|entscheidet|pr(?:ue|ü)ft|(?:ue|ü)bernimmt|kl(?:ae|ä)rt|schaut|bitte|must|should|decides|please)`,
          `\\b(?:r(?:ue|ü)ckfrage|entscheidung)\\s+(?:an|bei)\\s+(?:${who})\\b`,
        ].map((p) => ['verweis', p])
      : []),
    ...[
      '\\bfolge(?:aufgabe|task|vorgang|arbeit|ticket)',
      '\\b(?:bleibt|bleiben)\\s+offen\\b',
      '\\boffen\\s+bleibt\\b',
      '\\b(?:muss|m(?:ue|ü)ssen|sollte|sollten)\\s+noch\\b',
      '\\bn(?:ae|ä)chster\\s+schritt\\b',
      '\\bnoch\\s+zu\\s+(?:tun|kl(?:ae|ä)ren|pr(?:ue|ü)fen|bauen|messen)\\b',
      '\\bfollow[- ]?up\\b',
      '\\bnext\\s+step\\b',
      '\\bstill\\s+(?:open|to\\s+do)\\b',
      '\\bTODO\\b',
    ].map((p) => ['folgearbeit', p]),
  ];
  for (const [kind, p] of patterns) {
    const m = new RegExp(p, 'i').exec(s);
    if (m) return { kind, quote: m[0].trim() };
  }
  return null;
}

// ── Approval details ───────────────────────────────────────────────────────────────────────────────
const RISK_WORDS = { low: 'low', niedrig: 'low', gering: 'low', klein: 'low', medium: 'medium', mittel: 'medium', high: 'high', hoch: 'high', kritisch: 'high', critical: 'high' };
const SENTENCE_ABBR = /\b(z\.\s?B|d\.\s?h|u\.\s?a|u\.\s?U|i\.\s?d\.\s?R|bzw|ca|inkl|evtl|ggf|usw|etc|vgl|Nr|e\.g|i\.e)\./gi;

export function sentences(text) {
  const t = String(text ?? '').split(/\s+/).join(' ').trim();
  if (!t) return [];
  const masked = t.replace(SENTENCE_ABBR, (m) => m.replaceAll('.', '․'));
  return masked.split(/(?<=[.!?…])\s+/).map((s) => s.replaceAll('․', '.').trim()).filter(Boolean);
}

/** risiko, zerstoererisch and kontext come together or not at all. Returns the fields to store, or null. */
export function approvalFields(body) {
  const keys = ['risiko', 'zerstoererisch', 'kontext'];
  const present = keys.filter((k) => body?.[k] !== undefined && body?.[k] !== null);
  if (!present.length) return null;
  const missing = keys.filter((k) => !present.includes(k));
  if (missing.length) throw new TicketError(422, `risiko, zerstoererisch and kontext come together; missing: ${missing.join(', ')}`);
  const risk = RISK_WORDS[String(body.risiko).trim().toLowerCase()];
  if (!risk) throw new TicketError(422, 'risiko must be low, medium or high');
  const flag = String(body.zerstoererisch).trim().toLowerCase();
  const destructive = ['true', 'ja', 'yes', '1'].includes(flag) ? 'ja' : ['false', 'nein', 'no', '0'].includes(flag) ? 'nein' : null;
  if (!destructive) throw new TicketError(422, 'zerstoererisch must be true or false');
  if (typeof body.kontext !== 'string') throw new TicketError(422, 'kontext must be text');
  // A token pasted by accident is redacted, not refused: the request should not fail on it, but it must never be shown.
  const context = schwaerzenText(body.kontext).text.split(/\s+/).join(' ').trim();
  // Counted before redacting: the redaction may swallow the full stop behind a token.
  const n = sentences(body.kontext).length;
  if (n < 3 || n > 5) throw new TicketError(422, `kontext needs 3 to 5 sentences (counted ${n}): what is planned, what it changes, where, how to go back`);
  if (context.length > TICKET_LIMITS.contextMax) throw new TicketError(422, `kontext has ${context.length} characters, at most ${TICKET_LIMITS.contextMax}`);
  return { freigabe_risiko: risk, freigabe_zerstoererisch: destructive, freigabe_kontext: context };
}

// ── Master rules ───────────────────────────────────────────────────────────────────────────────────
const isDone = (t) => DONE.includes(t.status);

export function childCounts(children) {
  const done = children.filter(isDone).length;
  return { kinder: children.length, kinder_resolved: done, kinder_offen: children.length - done };
}

export function missingToResolve(ticket, children) {
  if (!children.length) return [];
  const missing = ['master_begruendung', 'master_muster'].filter((f) => !String(ticket[f] ?? '').trim());
  const sample = String(ticket.master_muster ?? '').trim();
  if (sample && !children.some((c) => c.id === sample)) missing.push(`master_muster points to ${sample}, which is no child of this master`);
  return missing;
}

// ── The store ──────────────────────────────────────────────────────────────────────────────────────
const dayIn = (ms, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

export class Tickets {
  /**
   * @param owner   name of the human who owns this runner (config `owner`)
   * @param agent   name of the agent (config `agent`), default assignee
   * @param actors  more registered actors: { name: { type: 'agent' | 'human' | 'system-job' } }
   */
  constructor({ store, bus = null, owner = 'owner', agent = 'agent', actors = {}, zone = 'Europe/Berlin', now = () => Date.now() } = {}) {
    this.store = store;
    this.bus = bus;
    this.owner = String(owner).toLowerCase();
    this.agent = String(agent).toLowerCase();
    this.zone = zone;
    this.now = now;
    this.actors = { [this.owner]: { type: 'human' }, [this.agent]: { type: 'agent' }, system: { type: 'system-job' }, webhook: { type: 'system-job' }, ...actors };
    store.migrate(MIGRATIONS);
    const db = store.db;
    this.q = {
      get: db.prepare('SELECT doc FROM tickets WHERE id = ?'),
      insert: db.prepare('INSERT INTO tickets (id, type, status, assignee, fingerprint, master, archived, updated, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      update: db.prepare('UPDATE tickets SET type = ?, status = ?, assignee = ?, fingerprint = ?, master = ?, archived = ?, updated = ?, doc = ? WHERE id = ?'),
      next: db.prepare("UPDATE ticket_seq SET n = n + 1 WHERE name = 'ticket' RETURNING n"),
      openByFingerprint: db.prepare(`SELECT doc FROM tickets WHERE fingerprint = ? AND archived = 0 AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) ORDER BY updated DESC LIMIT 1`),
      children: db.prepare('SELECT doc FROM tickets WHERE master = ?'),
      history: db.prepare('SELECT seq, ts, event, actor, detail, origin FROM ticket_history WHERE ticket = ? ORDER BY seq DESC LIMIT ?'),
      addHistory: db.prepare('INSERT INTO ticket_history (ticket, ts, event, actor, detail, origin) VALUES (?, ?, ?, ?, ?, ?)'),
      lastComment: db.prepare("SELECT detail FROM ticket_history WHERE ticket = ? AND event = 'comment' AND actor = ? ORDER BY seq DESC LIMIT 1"),
      flapGet: db.prepare('SELECT ticket, until FROM ticket_flap WHERE fingerprint = ?'),
      flapSet: db.prepare('INSERT INTO ticket_flap (fingerprint, ticket, until) VALUES (?, ?, ?) ON CONFLICT (fingerprint) DO UPDATE SET ticket = excluded.ticket, until = excluded.until'),
      flapTrim: db.prepare('DELETE FROM ticket_flap WHERE until < ?'),
      byStatus: db.prepare('SELECT doc FROM tickets WHERE archived = 0 AND status = ?'),
      counts: db.prepare('SELECT type, status, COUNT(*) AS n FROM tickets WHERE archived = 0 GROUP BY type, status'),
      requestGet: db.prepare('SELECT result FROM ticket_requests WHERE id = ?'),
      requestSet: db.prepare('INSERT INTO ticket_requests (id, result, t) VALUES (?, ?, ?)'),
    };
  }

  /** A repeated request (a tool call replayed after a crash) gets its first answer back instead of acting twice. */
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

  #iso() {
    return new Date(this.now()).toISOString();
  }

  #today() {
    return dayIn(this.now(), this.zone);
  }

  /** Registry check: free text is refused, otherwise the board fills with names nobody can tell apart. */
  actor(name) {
    const a = String(name ?? '').trim().toLowerCase();
    if (!Object.hasOwn(this.actors, a)) throw new TicketError(400, `unknown actor ${JSON.stringify(name)}; registered: ${Object.keys(this.actors).sort().join(', ')}`);
    return a;
  }

  #human(actor) {
    return this.actors[actor]?.type === 'human';
  }

  #read(id) {
    const r = this.q.get.get(String(id));
    return r ? JSON.parse(r.doc) : null;
  }

  #must(id) {
    const t = this.#read(id);
    if (!t) throw new TicketError(404, `no ticket ${id}`);
    return t;
  }

  #write(t, { fresh = false } = {}) {
    const values = [t.type, t.status, t.assignee, t.fingerprint || null, t.master || null, t.archived_at ? 1 : 0, this.now(), JSON.stringify(t)];
    if (fresh) this.q.insert.run(t.id, ...values);
    else this.q.update.run(...values, t.id);
  }

  #history(id, event, actor, detail = '', origin = null) {
    const ts = this.#iso();
    this.q.addHistory.run(id, ts, event, actor || 'system', cut(detail), origin);
    return { ts, event, actor, detail };
  }

  /** Every change goes on the bus, for the board, the app and the bridges. */
  #announce(id, event, actor, detail, origin = null) {
    this.bus?.publish({
      topic: TOPICS.TICKETS,
      id: `${id}:${event}:${this.now()}:${Math.random().toString(36).slice(2, 8)}`,
      source: 'tickets',
      from: actor,
      ref: id,
      text: `${id} ${event}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`,
      data: { ticket: id, event, actor, origin },
    });
  }

  /** What the agent has to react to goes into its inbox; `owner` marks that the owner did it (right of way). */
  #wake(id, kind, text, { owner = false, key = this.now(), severity = null } = {}) {
    this.bus?.publish(
      { topic: TOPICS.INBOX, id: `tickets:${id}:${kind}:${key}`, source: 'tickets', from: owner ? this.owner : 'tickets', ref: id, text, severity },
      { owner },
    );
  }

  /**
   * Create a ticket, or count another occurrence when its fingerprint is already known.
   * Returns { ticket, created, deduped_to?, deduped_reason? }.
   */
  create(body = {}, { actor, origin = null } = {}) {
    const type = String(body.type ?? 'INC').toUpperCase();
    if (!TICKET_TYPES.includes(type)) throw new TicketError(400, `type must be one of ${TICKET_TYPES.join(', ')}`);
    const title = String(body.title ?? '').trim();
    if (!title) throw new TicketError(400, 'title is required');
    const severity = String(body.severity ?? 'medium').toLowerCase();
    if (!SEVERITIES.includes(severity)) throw new TicketError(400, `severity must be one of ${SEVERITIES.join(', ')}`);
    const reporter = this.actor(actor ?? body.reporter ?? 'system');
    const assignee = this.actor(body.assignee ?? this.agent);
    const fingerprint = String(body.fingerprint ?? '').trim().slice(0, TICKET_LIMITS.fingerprint);

    return this.store.transaction(() => {
      const links = normaliseLinks(body.links ?? body.linked_tickets);
      if (fingerprint) {
        const open = this.q.openByFingerprint.get(fingerprint, ...OPEN_STATUSES);
        if (open) return { ticket: this.#occurrence(JSON.parse(open.doc), body, reporter), created: false, deduped_to: JSON.parse(open.doc).id };
        const flap = this.q.flapGet.get(fingerprint);
        if (flap) {
          const old = this.#read(flap.ticket);
          if (flap.until > this.now() && old && !old.archived_at) {
            return { ticket: this.#occurrence(old, body, reporter), created: false, deduped_to: old.id, deduped_reason: 'flap' };
          }
          if (old && DONE.includes(old.status) && !links.includes(old.id)) links.push(old.id);
        }
      }
      const master = String(body.master ?? '').trim().slice(0, 32);
      const n = Number(this.q.next.get().n);
      const id = `${type}-P${n}`;
      if (master) this.#checkMaster(id, master);
      const ts = this.#iso();
      const ticket = {
        id,
        type,
        title: title.slice(0, TICKET_LIMITS.title),
        // Three names for the same text are in use; an unknown field must not vanish silently.
        description: cut(body.description ?? body.detail ?? body.text ?? '', TICKET_LIMITS.description),
        status: this.#startStatus(type, reporter, body.status),
        severity,
        source: String(body.source ?? 'api').slice(0, 100),
        reporter,
        assignee,
        fingerprint,
        links: links.join(',').slice(0, TICKET_LIMITS.links),
        waiting_for: String(body.waiting_for ?? '').slice(0, TICKET_LIMITS.waitingFor),
        waiting_since: '',
        wiedervorlage: '',
        wiedervorlage_quelle: '',
        master,
        master_begruendung: String(body.master_begruendung ?? '').slice(0, TICKET_LIMITS.masterReason),
        master_muster: String(body.master_muster ?? '').trim().slice(0, 32),
        occurrences: 1,
        created_at: ts,
        updated_at: ts,
        resolved_at: '',
        closed_at: '',
        archived_at: '',
      };
      if (ticket.status === 'triage') {
        const f = followUpForTriage(null, body.wiedervorlage, this.#today());
        ticket.wiedervorlage = f.date;
        ticket.wiedervorlage_quelle = f.origin;
      }
      if (ticket.status === 'waiting_approval') {
        ticket.waiting_since = ts;
        Object.assign(ticket, approvalFields(body) ?? {});
      }
      this.#write(ticket, { fresh: true });
      this.#history(id, 'created', reporter, `${type} '${title.slice(0, 80)}' severity=${severity}`, origin);
      this.#announce(id, 'created', reporter, title, origin);
      return { ticket: this.#view(ticket), created: true };
    });
  }

  #startStatus(type, reporter, wanted) {
    const w = String(wanted ?? '').toLowerCase();
    if (w && STATUSES.includes(w)) return w;
    return PLAN_TYPES.includes(type) && !this.#human(reporter) ? 'triage' : 'new';
  }

  #occurrence(ticket, body, actor) {
    ticket.occurrences = Number(ticket.occurrences ?? 1) + 1;
    ticket.last_occurrence_at = this.#iso();
    ticket.updated_at = ticket.last_occurrence_at;
    this.#write(ticket);
    this.#history(ticket.id, 'occurrence', actor, String(body.description ?? body.detail ?? body.text ?? body.title ?? '').slice(0, 500));
    this.#announce(ticket.id, 'occurrence', actor, '');
    return this.#view(ticket);
  }

  #checkMaster(id, master) {
    if (!this.#read(master)) throw new TicketError(422, `master ${master} does not exist`);
    if (master === id) throw new TicketError(422, 'a ticket cannot be its own master');
    const seen = new Set([id, master]);
    let run = master;
    for (;;) {
      run = this.#read(run)?.master;
      if (!run) return;
      if (seen.has(run)) throw new TicketError(422, `master ${master} would close a circle over ${run}`);
      seen.add(run);
    }
  }

  #children(id) {
    return this.q.children.all(id).map((r) => JSON.parse(r.doc));
  }

  #view(ticket) {
    const children = this.#children(ticket.id);
    return children.length ? { ...ticket, ...childCounts(children) } : ticket;
  }

  get(id) {
    const t = this.#read(id);
    return t ? this.#view(t) : null;
  }

  /** The ticket with its history, newest first. */
  detail(id, { history = 100 } = {}) {
    const t = this.#must(id);
    return { ...this.#view(t), verlauf: this.history(id, history), kinder_ids: this.#children(id).map((c) => c.id) };
  }

  history(id, limit = 100) {
    return this.q.history.all(String(id), Math.max(1, Math.min(Number(limit) || 100, 1000))).map((r) => ({ ...r }));
  }

  /** Filter by status, type, assignee, text; archived tickets only when asked for. Newest change first. */
  list({ status, type, assignee, q, archived = false, limit = 100, offset = 0 } = {}) {
    const where = ['archived = ?'];
    const args = [archived ? 1 : 0];
    const list = (value) => (Array.isArray(value) ? value : String(value).split(',')).map((x) => x.trim()).filter(Boolean);
    if (status) {
      const s = list(status);
      where.push(`status IN (${s.map(() => '?').join(',')})`);
      args.push(...s);
    }
    if (type) {
      where.push('type = ?');
      args.push(String(type).toUpperCase());
    }
    if (assignee) {
      where.push('assignee = ?');
      args.push(String(assignee).toLowerCase());
    }
    if (q) {
      where.push('doc LIKE ? ESCAPE \'\\\'');
      args.push(`%${String(q).replace(/[\\%_]/g, '\\$&')}%`);
    }
    const n = Math.max(1, Math.min(Number(limit) || 100, 500));
    const from = Math.max(0, Number(offset) || 0);
    const sql = `FROM tickets WHERE ${where.join(' AND ')}`;
    const rows = this.store.db.prepare(`SELECT doc ${sql} ORDER BY updated DESC, id LIMIT ? OFFSET ?`).all(...args, n, from);
    const total = Number(this.store.db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args).n);
    return { tickets: rows.map((r) => this.#view(JSON.parse(r.doc))), total, limit: n, offset: from };
  }

  /** What waits for the owner: open approvals first, oldest question first. */
  waiting() {
    const rows = this.q.byStatus.all('waiting_approval').map((r) => JSON.parse(r.doc));
    rows.sort((a, b) => String(a.waiting_since).localeCompare(String(b.waiting_since)));
    return { anzahl: rows.length, tickets: rows.map((t) => this.#view(t)) };
  }

  /** Counts per column for the board, by type and in total. */
  board() {
    const columns = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    const types = Object.fromEntries(TICKET_TYPES.map((t) => [t, { ...columns }]));
    for (const r of this.q.counts.all()) {
      if (types[r.type] && r.status in columns) {
        types[r.type][r.status] = r.n;
        columns[r.status] += r.n;
      }
    }
    return { columns, types, statuses: STATUSES };
  }

  /** Change a ticket. All gates sit here: every writer has to pass through this one place. */
  update(id, patch = {}, { actor, origin = null } = {}) {
    const who = this.actor(actor ?? patch.actor);
    return this.store.transaction(() => {
      const ticket = this.#must(id);
      if (ticket.archived_at) throw new TicketError(409, `${id} is archived; restore it first`);
      const old = ticket.status;
      const changes = [];

      if (patch.expected_status !== undefined && patch.expected_status !== null) {
        const expected = String(patch.expected_status).toLowerCase();
        if (!STATUSES.includes(expected)) throw new TicketError(400, `expected_status must be one of ${STATUSES.join(', ')}`);
        if (old !== expected) throw new TicketError(409, `${id} was already decided (status ${old}, expected ${expected})`);
      }
      const approval = approvalFields(patch);
      if (approval && String(patch.status ?? old).toLowerCase() !== 'waiting_approval') {
        throw new TicketError(422, 'risiko, zerstoererisch and kontext exist only on an approval (status waiting_approval)');
      }

      if (patch.title !== undefined) {
        const title = String(patch.title).trim();
        if (!title) throw new TicketError(400, 'title must not be empty');
        ticket.title = title.slice(0, TICKET_LIMITS.title);
        changes.push('title');
      }
      const text = patch.description ?? patch.detail ?? patch.text;
      if (text !== undefined) {
        ticket.description = cut(text, TICKET_LIMITS.description);
        changes.push('description');
      }
      if (patch.severity !== undefined) {
        const severity = String(patch.severity).toLowerCase();
        if (!SEVERITIES.includes(severity)) throw new TicketError(400, `severity must be one of ${SEVERITIES.join(', ')}`);
        if (severity !== ticket.severity) changes.push(`severity ${ticket.severity}→${severity}`);
        ticket.severity = severity;
      }
      if (patch.assignee !== undefined) {
        const assignee = this.actor(patch.assignee);
        if (assignee !== ticket.assignee) changes.push(`assignee ${ticket.assignee}→${assignee}`);
        ticket.assignee = assignee;
      }
      if (patch.waiting_for !== undefined) {
        ticket.waiting_for = String(patch.waiting_for).slice(0, TICKET_LIMITS.waitingFor);
        changes.push('waiting_for');
      }
      if (patch.links !== undefined || patch.linked_tickets !== undefined) {
        ticket.links = normaliseLinks(patch.links ?? patch.linked_tickets).join(',').slice(0, TICKET_LIMITS.links);
        changes.push('links');
      }
      if (patch.master !== undefined) {
        const master = String(patch.master).trim().slice(0, 32);
        if (master) this.#checkMaster(id, master);
        ticket.master = master;
        changes.push(master ? `master ${master}` : 'master removed');
      }
      for (const field of ['master_begruendung', 'master_muster']) {
        if (patch[field] !== undefined) ticket[field] = String(patch[field]).slice(0, field === 'master_muster' ? 32 : TICKET_LIMITS.masterReason);
      }

      if (patch.wiedervorlage !== undefined && !patch.status) {
        if (ticket.status !== 'triage') throw new TicketError(409, `${id} is ${ticket.status}, not triage; a follow-up date has nothing to pull back to`);
        const f = followUpForTriage(null, patch.wiedervorlage, this.#today());
        ticket.wiedervorlage = f.date;
        ticket.wiedervorlage_quelle = f.origin;
        changes.push(`wiedervorlage ${f.date}`);
      }

      if (patch.status) this.#changeStatus(ticket, String(patch.status).toLowerCase(), patch, who, changes);
      if (approval) {
        Object.assign(ticket, approval);
        changes.push('approval details');
      }

      if (!changes.length) return this.#view(ticket);
      ticket.updated_at = this.#iso();
      this.#write(ticket);
      const detail = changes.join('; ');
      this.#history(id, 'updated', who, detail, origin);
      this.#announce(id, 'updated', who, detail, origin);
      if (ticket.status !== old) this.#afterStatus(ticket, old, who);
      return this.#view(ticket);
    });
  }

  #changeStatus(ticket, wanted, patch, who, changes) {
    const old = ticket.status;
    let target = wanted;
    if (!STATUSES.includes(target)) throw new TicketError(400, `status must be one of ${STATUSES.join(', ')}`);
    const children = this.#children(ticket.id);
    if (children.length && target === 'resolved') {
      const missing = missingToResolve({ ...ticket, ...patch }, children);
      if (missing.length) throw new TicketError(422, `a master resolves only with a reason and a sample child; missing: ${missing.join('; ')}`);
    }
    if (children.length && target === 'closed') {
      const open = children.filter((c) => !isDone(c)).map((c) => c.id).sort();
      if (open.length) throw new TicketError(409, `a master closes only when all children are resolved; open: ${open.join(', ')}`);
    }
    // The human gate works both ways: only a human closes, and only a human reopens what was closed.
    if (target === 'closed' && !this.#human(who)) throw new TicketError(403, `only a human may set closed (actor ${who}); use resolved`);
    if (old === 'closed' && !this.#human(who)) throw new TicketError(403, `${ticket.id} is closed; only a human may change that. Open a new ticket with links=${ticket.id}`);

    if (target === 'resolved' && old !== 'resolved' && !this.#human(who)) {
      const note = patch.comment ?? this.q.lastComment.get(ticket.id, who)?.detail;
      const found = handsOver(note, [this.owner]);
      if (found) {
        target = 'waiting_approval';
        this.#history(ticket.id, 'redirected', 'system', `resolved→waiting_approval: ${found.kind} in the closing note of ${who} („${found.quote}“). Handing on is not finishing.`);
        changes.push(`resolved→waiting_approval (${found.kind}: „${found.quote}“)`);
      }
    }

    if (target === 'triage') {
      const f = followUpForTriage(ticket.wiedervorlage, patch.wiedervorlage, this.#today());
      if (f.date !== ticket.wiedervorlage) changes.push(`wiedervorlage ${f.date}${f.origin === 'standard' ? ' (default)' : ''}`);
      ticket.wiedervorlage = f.date;
      ticket.wiedervorlage_quelle = f.origin;
    } else if (old === 'triage' && ticket.wiedervorlage) {
      ticket.wiedervorlage = '';
      ticket.wiedervorlage_quelle = '';
      changes.push('wiedervorlage removed (left triage)');
    }

    if (target === old) return;
    ticket.status = target;
    const ts = this.#iso();
    if (target === 'waiting_approval') ticket.waiting_since = ts;
    if (old === 'waiting_approval') {
      ticket.waiting_since = '';
      if (ticket.freigabe_kontext || ticket.freigabe_risiko) {
        ticket.freigabe_risiko = '';
        ticket.freigabe_zerstoererisch = '';
        ticket.freigabe_kontext = '';
        changes.push('approval details removed');
      }
    }
    if (target === 'resolved') ticket.resolved_at = ts;
    if (target === 'closed') ticket.closed_at = ts;
    else if (old === 'closed') ticket.closed_at = '';
    changes.push(`status ${old}→${target}`);
    if (DONE.includes(target) && ticket.fingerprint) {
      this.q.flapSet.run(ticket.fingerprint, ticket.id, this.now() + TICKET_LIMITS.flapHours * 3600_000);
    }
  }

  /** Wake the agent for the answers it waits for. Only the owner's own answer counts as an approval. */
  #afterStatus(ticket, old, who) {
    if (old !== 'waiting_approval' || ticket.assignee !== this.agent) return;
    const name = `${ticket.id} „${String(ticket.title).slice(0, 120)}“`;
    if (who !== this.owner) return;
    if (ticket.status === 'in_progress') {
      this.#wake(ticket.id, 'granted', tx(
        `Die Freigabe am Vorgang ${name} wurde erteilt. Führe genau den beantragten Schritt aus, nichts darüber hinaus, und schreib Ergebnis und Beleg an den Vorgang.`,
        `The approval on ticket ${name} was granted. Carry out exactly the requested step, nothing more, and write the result and evidence on the ticket.`,
      ), { owner: true });
    } else if (ticket.status === 'triage') {
      this.#wake(ticket.id, 'refused', tx(
        `Die Freigabe am Vorgang ${name} wurde abgelehnt. Führe den Schritt nicht aus. Such eine Alternative im Rahmen deiner Regeln oder vermerke am Vorgang, dass er ruht.`,
        `The approval on ticket ${name} was refused. Do not carry out the step. Look for an alternative within your rules or note on the ticket that it rests.`,
      ), { owner: true });
    } else {
      this.#wake(ticket.id, 'ended', tx(
        `Der Vorgang ${name} wurde auf ${ticket.status} gesetzt, statt die Freigabe zu beantworten. Der beantragte Schritt entfällt.`,
        `Ticket ${name} was set to ${ticket.status} instead of answering the approval. The requested step is dropped.`,
      ), { owner: true });
    }
  }

  comment(id, text, { actor, origin = null } = {}) {
    const who = this.actor(actor);
    const body = String(text ?? '').trim();
    if (!body) throw new TicketError(400, 'text is required');
    return this.store.transaction(() => {
      const ticket = this.#must(id);
      if (ticket.archived_at) throw new TicketError(409, `${id} is archived; restore it first`);
      ticket.updated_at = this.#iso();
      this.#write(ticket);
      const entry = this.#history(id, 'comment', who, body, origin);
      this.#announce(id, 'comment', who, body, origin);
      if (who === this.owner && ticket.assignee === this.agent) {
        this.#wake(id, 'comment', tx(
          `Am Vorgang ${id} „${String(ticket.title).slice(0, 120)}“ steht ein neuer Kommentar deines Besitzers:\n${cut(body, 1500)}`,
          `Your owner commented on ticket ${id} „${String(ticket.title).slice(0, 120)}“:\n${cut(body, 1500)}`,
        ), { owner: true, key: entry.ts });
      }
      return entry;
    });
  }

  /** Archiving takes a ticket out of active work without claiming it was solved; nothing is lost. */
  archive(id, { actor, reason = '' } = {}) {
    const who = this.actor(actor);
    return this.store.transaction(() => {
      const ticket = this.#must(id);
      if (ticket.archived_at) return this.#view(ticket);
      ticket.archived_at = this.#iso();
      ticket.archive_reason = String(reason).slice(0, 500);
      ticket.updated_at = ticket.archived_at;
      this.#write(ticket);
      this.#history(id, 'archived', who, ticket.archive_reason);
      this.#announce(id, 'archived', who, ticket.archive_reason);
      return this.#view(ticket);
    });
  }

  unarchive(id, { actor } = {}) {
    const who = this.actor(actor);
    return this.store.transaction(() => {
      const ticket = this.#must(id);
      if (!ticket.archived_at) return this.#view(ticket);
      ticket.archived_at = '';
      ticket.archive_reason = '';
      ticket.updated_at = this.#iso();
      this.#write(ticket);
      this.#history(id, 'unarchived', who);
      this.#announce(id, 'unarchived', who, '');
      return this.#view(ticket);
    });
  }

  /**
   * One round of the clock: due follow-ups go from triage to `new`; approvals unanswered for 72 h go back to `new` with a note.
   * Returns what it moved. An unreadable date counts as due: a ticket without a way back should come back into the light.
   */
  sweep() {
    return this.store.transaction(() => {
      const today = this.#today();
      const moved = [];
      this.q.flapTrim.run(this.now());
      for (const row of this.q.byStatus.all('triage')) {
        const t = JSON.parse(row.doc);
        const date = String(t.wiedervorlage ?? '');
        if (ISO_DAY.test(date) && date > today) continue;
        const why = date ? `follow-up ${date} reached` : 'no follow-up date on the ticket';
        t.status = 'new';
        t.wiedervorlage = '';
        t.wiedervorlage_quelle = '';
        t.updated_at = this.#iso();
        this.#write(t);
        this.#history(t.id, 'updated', 'system', `status triage→new: ${why}`);
        this.#announce(t.id, 'updated', 'system', `status triage→new: ${why}`);
        moved.push({ id: t.id, to: 'new', why });
      }
      const deadline = this.now() - TICKET_LIMITS.approvalHours * 3600_000;
      for (const row of this.q.byStatus.all('waiting_approval')) {
        const t = JSON.parse(row.doc);
        const since = Date.parse(t.waiting_since);
        // Unreadable time: never expires. Only approvals with a fingerprint expire, a question from a closing note does not.
        if (!t.fingerprint || !Number.isFinite(since) || since > deadline) continue;
        t.status = 'new';
        t.waiting_for = '';
        t.waiting_since = '';
        t.freigabe_risiko = '';
        t.freigabe_zerstoererisch = '';
        t.freigabe_kontext = '';
        t.updated_at = this.#iso();
        this.#write(t);
        const note = tx(
          `Die Freigabe blieb ${TICKET_LIMITS.approvalHours} Stunden unbeantwortet. Nichts entschieden, nichts ausgeführt.`,
          `The approval stayed unanswered for ${TICKET_LIMITS.approvalHours} hours. Nothing decided, nothing carried out.`,
        );
        this.#history(t.id, 'comment', 'system', note);
        this.#history(t.id, 'updated', 'system', 'status waiting_approval→new: expired');
        this.#announce(t.id, 'updated', 'system', 'status waiting_approval→new: expired');
        if (t.assignee === this.agent) this.#wake(t.id, 'expired', `${t.id}: ${note}`);
        moved.push({ id: t.id, to: 'new', why: 'approval expired' });
      }
      return moved;
    });
  }

  /** The agent's backlog: open tickets assigned to it that wait for work, most severe first, then oldest. */
  backlog(assignee = this.agent, limit = 50) {
    const rank = Object.fromEntries(SEVERITIES.map((s, i) => [s, i + 1]));
    const rows = this.list({ status: ['new', 'in_progress'], assignee, limit: 500 }).tickets;
    rows.sort((a, b) => (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0) || String(a.created_at).localeCompare(String(b.created_at)));
    return rows.slice(0, limit);
  }
}

export const isTicketId = (id) => ID.test(String(id ?? ''));
export const TICKET_BACKGROUND_CLASS = BACKGROUND_CLASS;

/** The clock of the ticket system: runs the sweep every `everyS` seconds. A failed round never takes the runner down. */
export function ticketClock({ tickets, everyS = 300, log = console }) {
  let timer = null;
  let last = null;
  let error = null;
  const round = () => {
    try {
      const moved = tickets.sweep();
      last = { at: Date.now(), moved: moved.length };
      error = null;
    } catch (fehler) {
      error = String(fehler?.message ?? fehler).slice(0, 200);
      log.error?.(`[tickets] sweep: ${error}`);
    }
  };
  return {
    inner: tickets,
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

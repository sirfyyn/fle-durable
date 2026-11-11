/**
 * The runner's own ticket system (src/platform/tickets.js): the rules of the FYOS ITSM, tested one by one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Bus, TOPICS } from '../src/platform/bus.js';
import { PlatformStore } from '../src/platform/store.js';
import {
  TICKET_LIMITS,
  TicketError,
  Tickets,
  approvalFields,
  childCounts,
  cut,
  followUpForTriage,
  handsOver,
  missingToResolve,
  parseFollowUp,
  sentences,
  ticketClock,
} from '../src/platform/tickets.js';
import { checkSource } from '../src/ports/conformance.js';

const START = Date.parse('2026-11-06T10:00:00Z');
const OWNER = 'max';
const AGENT = 'paula';

function setup(extra = {}) {
  const clock = { t: START };
  const store = new PlatformStore(':memory:');
  const bus = new Bus({ store, now: () => clock.t });
  const tickets = new Tickets({ store, bus, owner: OWNER, agent: AGENT, zone: 'UTC', now: () => clock.t, ...extra });
  return { store, bus, tickets, clock };
}

const fails = (fn, status, pattern) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof TicketError, `expected TicketError, got ${e}`);
    assert.equal(e.status, status);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });

const CONTEXT = 'Wir starten den Dienst neu. Das ändert nur den laufenden Prozess. Es betrifft Hauptserver. Zurück geht es mit einem weiteren Neustart.';

test('create: fields, own id with P, history, event on the bus', () => {
  const { tickets, bus } = setup();
  const { ticket, created } = tickets.create({ type: 'inc', title: '  Build rot  ', detail: 'Text', severity: 'HIGH', links: 'PRB-1, PRB-1,CHG-2' }, { actor: OWNER });
  assert.equal(created, true);
  assert.equal(ticket.id, 'INC-P1');
  assert.equal(ticket.title, 'Build rot');
  assert.equal(ticket.description, 'Text');
  assert.equal(ticket.severity, 'high');
  assert.equal(ticket.status, 'new');
  assert.equal(ticket.reporter, OWNER);
  assert.equal(ticket.assignee, AGENT);
  assert.equal(ticket.links, 'PRB-1,CHG-2');
  assert.equal(ticket.occurrences, 1);
  assert.equal(tickets.history('INC-P1').at(-1).event, 'created');
  assert.equal(bus.read({ topic: TOPICS.TICKETS }).at(-1).data.event, 'created');
  assert.equal(tickets.create({ type: 'PRB', title: 'x' }, { actor: OWNER }).ticket.id, 'PRB-P2');
});

test('create: invalid input and unknown actors are refused', () => {
  const { tickets } = setup();
  fails(() => tickets.create({ type: 'XXX', title: 'x' }, { actor: OWNER }), 400, /type/);
  fails(() => tickets.create({ title: ' ' }, { actor: OWNER }), 400, /title/);
  fails(() => tickets.create({ title: 'x', severity: 'huge' }, { actor: OWNER }), 400, /severity/);
  fails(() => tickets.create({ title: 'x' }, { actor: 'stranger' }), 400, /unknown actor/);
  fails(() => tickets.create({ title: 'x', assignee: 'stranger' }, { actor: OWNER }), 400, /unknown actor/);
});

test('create: text is never cut silently', () => {
  const { tickets } = setup();
  const { ticket } = tickets.create({ title: 'x', description: 'a'.repeat(5000) }, { actor: OWNER });
  assert.equal(ticket.description.length, TICKET_LIMITS.description);
  assert.match(ticket.description, /cut: 4000 of 5000/);
  assert.equal(cut('short'), 'short');
});

test('start status: plans by the agent wait in triage with a way back, the owner and incidents start in new', () => {
  const { tickets } = setup();
  const plan = tickets.create({ type: 'VOR', title: 'Idee' }, { actor: AGENT }).ticket;
  assert.equal(plan.status, 'triage');
  assert.equal(plan.wiedervorlage, '2026-11-20');
  assert.equal(plan.wiedervorlage_quelle, 'standard');
  assert.equal(tickets.create({ type: 'CHG', title: 'Vom Besitzer' }, { actor: OWNER }).ticket.status, 'new');
  assert.equal(tickets.create({ type: 'INC', title: 'Fehler' }, { actor: AGENT }).ticket.status, 'new');
  assert.equal(tickets.create({ type: 'VOR', title: 'Direkt', status: 'in_progress' }, { actor: AGENT }).ticket.status, 'in_progress');
});

test('follow-up date: forms, limits, what counts for triage', () => {
  const today = '2026-11-06';
  assert.equal(parseFollowUp('+14t', today), '2026-11-20');
  assert.equal(parseFollowUp('+2w', today), '2026-11-20');
  assert.equal(parseFollowUp('+1m', today), '2026-12-06');
  assert.equal(parseFollowUp('2026-12-24', today), '2026-12-24');
  assert.equal(parseFollowUp('', today), '');
  assert.throws(() => parseFollowUp('morgen', today), /no date/);
  assert.throws(() => parseFollowUp('2026-11-06', today), /not in the future/);
  assert.throws(() => parseFollowUp('2099-01-01', today), /days away/);
  assert.throws(() => parseFollowUp('+999t', today), /at most/);
  assert.deepEqual(followUpForTriage('2026-12-01', null, today), { date: '2026-12-01', origin: 'gesetzt' });
  assert.deepEqual(followUpForTriage('2026-01-01', null, today), { date: '2026-11-20', origin: 'standard' });
  assert.deepEqual(followUpForTriage('2026-12-01', '+1t', today), { date: '2026-11-07', origin: 'gesetzt' });
});

test('status: triage gets a date, leaving it removes the date; times follow the status', () => {
  const { tickets, clock } = setup();
  const { id } = tickets.create({ title: 'x' }, { actor: OWNER }).ticket;
  let t = tickets.update(id, { status: 'triage', wiedervorlage: '+3t' }, { actor: AGENT });
  assert.equal(t.wiedervorlage, '2026-11-09');
  assert.equal(t.wiedervorlage_quelle, 'gesetzt');
  t = tickets.update(id, { status: 'in_progress' }, { actor: AGENT });
  assert.equal(t.wiedervorlage, '');
  clock.t += 1000;
  t = tickets.update(id, { status: 'resolved' }, { actor: AGENT });
  assert.ok(t.resolved_at);
  t = tickets.update(id, { status: 'closed' }, { actor: OWNER });
  assert.ok(t.closed_at);
  t = tickets.update(id, { status: 'in_progress' }, { actor: OWNER });
  assert.equal(t.closed_at, '');
});

test('human gate: only a human closes, and only a human reopens', () => {
  const { tickets } = setup();
  const { id } = tickets.create({ title: 'x' }, { actor: OWNER }).ticket;
  fails(() => tickets.update(id, { status: 'closed' }, { actor: AGENT }), 403, /only a human/);
  tickets.update(id, { status: 'closed' }, { actor: OWNER });
  fails(() => tickets.update(id, { status: 'in_progress' }, { actor: AGENT }), 403, /new ticket/);
  assert.equal(tickets.get(id).status, 'closed');
});

test('expected_status: the first valid answer wins, the second gets a conflict', () => {
  const { tickets } = setup();
  const { id } = tickets.create({ title: 'x', status: 'waiting_approval' }, { actor: AGENT }).ticket;
  tickets.update(id, { status: 'in_progress', expected_status: 'waiting_approval' }, { actor: OWNER });
  fails(() => tickets.update(id, { status: 'triage', expected_status: 'waiting_approval' }, { actor: OWNER }), 409, /already decided/);
  assert.equal(tickets.get(id).status, 'in_progress');
});

test('hand-over: a closing note that hands work on becomes an approval question, quoting the words', () => {
  assert.equal(handsOver('Alles erledigt und gemessen.', [OWNER]), null);
  assert.equal(handsOver('maximal 5 Minuten, offenbar stabil', [OWNER]), null);
  assert.equal(handsOver(`${OWNER} muss das entscheiden`, [OWNER]).kind, 'verweis');
  assert.equal(handsOver('Nächster Schritt: bauen', [OWNER]).kind, 'folgearbeit');
  assert.equal(handsOver('next step is to deploy', []).quote, 'next step');

  const { tickets } = setup();
  const { id } = tickets.create({ title: 'x' }, { actor: OWNER }).ticket;
  tickets.comment(id, 'Fertig, aber das bleibt offen.', { actor: AGENT });
  const t = tickets.update(id, { status: 'resolved' }, { actor: AGENT });
  assert.equal(t.status, 'waiting_approval');
  assert.match(tickets.history(id).find((h) => h.event === 'redirected').detail, /bleibt offen/);
  assert.equal(tickets.update(id, { status: 'resolved' }, { actor: OWNER }).status, 'resolved');
});

test('approval details: together or not at all, checked, a secret is redacted, removed on leaving', () => {
  assert.equal(approvalFields({}), null);
  assert.throws(() => approvalFields({ risiko: 'low' }), /come together/);
  assert.throws(() => approvalFields({ risiko: 'x', zerstoererisch: true, kontext: CONTEXT }), /risiko/);
  assert.throws(() => approvalFields({ risiko: 'low', zerstoererisch: 'vielleicht', kontext: CONTEXT }), /zerstoererisch/);
  assert.throws(() => approvalFields({ risiko: 'low', zerstoererisch: false, kontext: 'Nur ein Satz.' }), /3 to 5 sentences/);
  assert.equal(sentences('Das ist z. B. ein Satz. Und noch einer.').length, 2);
  const f = approvalFields({ risiko: 'hoch', zerstoererisch: 'ja', kontext: `${CONTEXT.slice(0, -1)} mit token=geheim123456.` });
  assert.equal(f.freigabe_risiko, 'high');
  assert.equal(f.freigabe_zerstoererisch, 'ja');
  assert.doesNotMatch(f.freigabe_kontext, /geheim123456/);

  const { tickets } = setup();
  const { id } = tickets.create({ title: 'x' }, { actor: OWNER }).ticket;
  fails(() => tickets.update(id, { risiko: 'low', zerstoererisch: false, kontext: CONTEXT }, { actor: AGENT }), 422, /only on an approval/);
  let t = tickets.update(id, { status: 'waiting_approval', risiko: 'low', zerstoererisch: false, kontext: CONTEXT }, { actor: AGENT });
  assert.equal(t.freigabe_risiko, 'low');
  assert.ok(t.waiting_since);
  t = tickets.update(id, { status: 'in_progress' }, { actor: OWNER });
  assert.equal(t.freigabe_kontext, '');
  assert.equal(t.waiting_since, '');
});

test('fingerprint: counts on the open ticket; after closing 24 h on the old one without reopening; later a new one with a link', () => {
  const { tickets, clock } = setup();
  const a = tickets.create({ title: 'CI rot', fingerprint: 'ci' }, { actor: 'webhook' });
  const b = tickets.create({ title: 'CI rot', fingerprint: 'ci', description: 'wieder' }, { actor: 'webhook' });
  assert.equal(b.created, false);
  assert.equal(b.deduped_to, a.ticket.id);
  assert.equal(b.ticket.occurrences, 2);
  tickets.update(a.ticket.id, { status: 'resolved' }, { actor: OWNER });
  clock.t += 3600_000;
  const c = tickets.create({ title: 'CI rot', fingerprint: 'ci' }, { actor: 'webhook' });
  assert.equal(c.deduped_reason, 'flap');
  assert.equal(c.ticket.status, 'resolved');
  assert.equal(c.ticket.occurrences, 3);
  clock.t += 25 * 3600_000;
  const d = tickets.create({ title: 'CI rot', fingerprint: 'ci' }, { actor: 'webhook' });
  assert.equal(d.created, true);
  assert.equal(d.ticket.links, a.ticket.id);
});

test('master: no circles, counts, resolve needs reason and sample child, closes only when children are done', () => {
  assert.deepEqual(childCounts([{ status: 'resolved' }, { status: 'closed' }, { status: 'new' }]), { kinder: 3, kinder_resolved: 2, kinder_offen: 1 });
  assert.deepEqual(missingToResolve({}, []), []);

  const { tickets } = setup();
  const m = tickets.create({ type: 'PRB', title: 'Master' }, { actor: OWNER }).ticket.id;
  const a = tickets.create({ title: 'Kind A', master: m }, { actor: OWNER }).ticket.id;
  const b = tickets.create({ title: 'Kind B', master: m }, { actor: OWNER }).ticket.id;
  fails(() => tickets.create({ title: 'x', master: 'INC-P99' }, { actor: OWNER }), 422, /does not exist/);
  fails(() => tickets.update(m, { master: a }, { actor: OWNER }), 422, /circle/);
  fails(() => tickets.update(m, { master: m }, { actor: OWNER }), 422, /own master/);
  assert.equal(tickets.get(m).kinder, 2);
  assert.deepEqual(tickets.detail(m).kinder_ids.sort(), [a, b].sort());

  fails(() => tickets.update(m, { status: 'resolved' }, { actor: OWNER }), 422, /reason and a sample/);
  fails(() => tickets.update(m, { status: 'resolved', master_begruendung: 'x', master_muster: 'INC-P99' }, { actor: OWNER }), 422, /no child/);
  fails(() => tickets.update(m, { status: 'closed' }, { actor: OWNER }), 409, new RegExp(a));
  tickets.update(a, { status: 'resolved' }, { actor: AGENT });
  tickets.update(b, { status: 'resolved' }, { actor: AGENT });
  assert.equal(tickets.update(m, { status: 'resolved', master_begruendung: 'gleiche Ursache', master_muster: a }, { actor: OWNER }).status, 'resolved');
  assert.equal(tickets.update(m, { status: 'closed' }, { actor: OWNER }).status, 'closed');
});

test('list, board, waiting, backlog', () => {
  const { tickets, clock } = setup();
  const a = tickets.create({ title: 'Eins Suchwort', severity: 'low' }, { actor: OWNER }).ticket.id;
  clock.t += 1000;
  const b = tickets.create({ title: 'Zwei', type: 'PRB', severity: 'critical' }, { actor: OWNER }).ticket.id;
  clock.t += 1000;
  const c = tickets.create({ title: 'Drei', status: 'waiting_approval' }, { actor: AGENT }).ticket.id;
  assert.equal(tickets.list().total, 3);
  assert.equal(tickets.list().tickets[0].id, c);
  assert.deepEqual(tickets.list({ q: 'suchwort' }).tickets.map((t) => t.id), [a]);
  assert.equal(tickets.list({ q: '%' }).total, 0);
  assert.deepEqual(tickets.list({ type: 'prb' }).tickets.map((t) => t.id), [b]);
  assert.equal(tickets.list({ status: 'new,waiting_approval' }).total, 3);
  assert.equal(tickets.list({ limit: 1, offset: 1 }).tickets[0].id, b);
  assert.equal(tickets.board().columns.new, 2);
  assert.equal(tickets.board().types.PRB.new, 1);
  assert.deepEqual(tickets.waiting().tickets.map((t) => t.id), [c]);
  assert.deepEqual(tickets.backlog().map((t) => t.id), [b, a]);
});

test('archive: leaves active work, nothing lost, changes need restoring first', () => {
  const { tickets } = setup();
  const { id } = tickets.create({ title: 'x' }, { actor: OWNER }).ticket;
  tickets.archive(id, { actor: OWNER, reason: 'Altlast' });
  assert.equal(tickets.list().total, 0);
  assert.equal(tickets.list({ archived: true }).total, 1);
  assert.equal(tickets.get(id).archive_reason, 'Altlast');
  fails(() => tickets.update(id, { title: 'y' }, { actor: OWNER }), 409, /archived/);
  fails(() => tickets.comment(id, 'y', { actor: OWNER }), 409, /archived/);
  tickets.unarchive(id, { actor: OWNER });
  assert.equal(tickets.update(id, { title: 'y' }, { actor: OWNER }).title, 'y');
});

test('sweep: due follow-up back to new; approval after 72 h back to new, neither yes nor no; without fingerprint or readable time it stays', () => {
  const { tickets, clock, bus } = setup();
  const plan = tickets.create({ type: 'VOR', title: 'Idee', wiedervorlage: '+4t' }, { actor: AGENT }).ticket.id;
  const asked = tickets.create({ title: 'Frage', status: 'waiting_approval', fingerprint: 'f1' }, { actor: AGENT }).ticket.id;
  const note = tickets.create({ title: 'Rückfrage', status: 'waiting_approval' }, { actor: AGENT }).ticket.id;
  assert.deepEqual(tickets.sweep(), []);
  clock.t += 71 * 3600_000;
  assert.deepEqual(tickets.sweep(), []);
  clock.t += 2 * 3600_000;
  assert.deepEqual(tickets.sweep().map((m) => m.id), [asked]);
  assert.equal(tickets.get(plan).status, 'triage');
  clock.t += 24 * 3600_000;
  assert.deepEqual(tickets.sweep().map((m) => m.id), [plan]);
  assert.equal(tickets.get(plan).status, 'new');
  assert.equal(tickets.get(plan).wiedervorlage, '');
  assert.equal(tickets.get(asked).status, 'new');
  assert.equal(tickets.get(asked).waiting_since, '');
  assert.equal(tickets.get(note).status, 'waiting_approval');
  assert.match(tickets.history(asked).find((h) => h.event === 'comment').detail, /unbeantwortet/);
  const woken = bus.read().find((e) => e.ref === asked);
  assert.equal(woken.class, 'hintergrund');
});

test('waking the agent: the owner comment and answer come with right of way; nobody else can grant', () => {
  const { tickets, bus } = setup({ actors: { helper: { type: 'agent' } } });
  const { id } = tickets.create({ title: 'Darf ich?', status: 'waiting_approval' }, { actor: AGENT }).ticket;
  tickets.update(id, { status: 'in_progress' }, { actor: 'helper' });
  assert.equal(bus.read().length, 0, 'a change by another agent is no approval');
  tickets.update(id, { status: 'waiting_approval' }, { actor: AGENT });
  tickets.update(id, { status: 'in_progress', expected_status: 'waiting_approval' }, { actor: OWNER });
  const granted = bus.read().at(-1);
  assert.equal(granted.class, 'max');
  assert.equal(granted.ref, id);
  assert.match(granted.text, /erteilt/);

  tickets.update(id, { status: 'waiting_approval' }, { actor: AGENT });
  tickets.update(id, { status: 'triage' }, { actor: OWNER });
  assert.match(bus.read().at(-1).text, /abgelehnt/);

  tickets.update(id, { status: 'waiting_approval' }, { actor: AGENT });
  tickets.update(id, { status: 'resolved' }, { actor: OWNER });
  assert.match(bus.read().at(-1).text, /entfällt/);

  const before = bus.read().length;
  tickets.comment(id, 'Von einem anderen', { actor: 'helper' });
  assert.equal(bus.read().length, before);
  tickets.comment(id, 'Bitte auch das prüfen', { actor: OWNER });
  const comment = bus.read().at(-1);
  assert.equal(comment.class, 'max');
  assert.match(comment.text, /Bitte auch das prüfen/);
});

test('a failed change leaves nothing behind', () => {
  const { tickets, bus } = setup();
  const { id } = tickets.create({ title: 'x' }, { actor: OWNER }).ticket;
  const before = { ticket: tickets.get(id), history: tickets.history(id).length, events: bus.read({ topic: TOPICS.TICKETS }).length };
  fails(() => tickets.update(id, { title: 'geändert', status: 'closed' }, { actor: AGENT }), 403);
  assert.deepEqual(tickets.get(id), before.ticket);
  assert.equal(tickets.history(id).length, before.history);
  assert.equal(bus.read({ topic: TOPICS.TICKETS }).length, before.events);
});

test('ticketClock: passes the source contract and runs the sweep', async () => {
  const { tickets } = setup();
  assert.deepEqual(await checkSource(() => ticketClock({ tickets })), []);
  const clock = ticketClock({ tickets, everyS: 1000 });
  clock.start();
  assert.equal(clock.state().running, true);
  assert.equal(clock.state().last.moved, 0);
  clock.stop();
  assert.equal(clock.state().running, false);
});

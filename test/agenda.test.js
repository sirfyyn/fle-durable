/**
 * Agenda of FLE Durable (src/ports/agenda.js): due times in a zone, checks, store rules, the source, the agent's tools.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENDA_LIMITS, AgendaStore, agendaEvent, agendaSource, agendaTools, nextDue, normaliseItem, wallToUtc } from '../src/ports/agenda.js';
import { checkSource } from '../src/ports/conformance.js';

const ZONE = 'Europe/Berlin';
const MIN = 60_000;

/** Enough of a harness for one document: snapshot gives a copy, commit hands out the live object. */
function fakeHarness() {
  const docs = new Map();
  const live = (doc) => {
    if (!docs.has(doc)) docs.set(doc, doc.initial ? doc.initial() : {});
    return docs.get(doc);
  };
  return {
    snapshot: async (doc) => (docs.has(doc) ? JSON.parse(JSON.stringify(docs.get(doc))) : undefined),
    commit: async (fn) => fn({ doc: async (doc) => live(doc) }),
  };
}

function store(now) {
  const h = fakeHarness();
  const clock = { t: now };
  return { s: new AgendaStore({ harness: () => h, zone: ZONE, now: () => clock.t }), clock };
}

const at = (iso) => Date.parse(iso);

test('wallToUtc: Berlin wall clock to real time, summer and winter', () => {
  assert.equal(new Date(wallToUtc(Date.UTC(2026, 6, 1, 9, 0), ZONE)).toISOString(), '2026-07-01T07:00:00.000Z');
  assert.equal(new Date(wallToUtc(Date.UTC(2026, 11, 1, 9, 0), ZONE)).toISOString(), '2026-12-01T08:00:00.000Z');
});

test('nextDue: daily, weekly (Monday = 1), interval, once; across the end of summer time', () => {
  const daily = { kind: 'daily', time: '08:00' };
  assert.equal(new Date(nextDue(daily, at('2026-11-02T06:00:00Z'), ZONE)).toISOString(), '2026-11-02T07:00:00.000Z');
  assert.equal(new Date(nextDue(daily, at('2026-11-02T07:00:00Z'), ZONE)).toISOString(), '2026-11-03T07:00:00.000Z');
  // 25.10.2026: Berlin goes from +2 to +1; 08:00 on the 24th is 06:00Z, on the 25th 07:00Z.
  assert.equal(new Date(nextDue(daily, at('2026-10-24T06:30:00Z'), ZONE)).toISOString(), '2026-10-25T07:00:00.000Z');
  // 2.11.2026 is a Monday; weekly on Wednesday and Friday.
  const weekly = { kind: 'weekly', time: '18:30', days: [3, 5] };
  assert.equal(new Date(nextDue(weekly, at('2026-11-02T12:00:00Z'), ZONE)).toISOString(), '2026-11-04T17:30:00.000Z');
  const every = { kind: 'interval', every_min: 30, anchor: at('2026-11-02T10:00:00Z') };
  assert.equal(new Date(nextDue(every, at('2026-11-02T10:45:00Z'), ZONE)).toISOString(), '2026-11-02T11:00:00.000Z');
  assert.equal(nextDue({ kind: 'once', at: 5 }, 10, ZONE), null);
});

test('normaliseItem: clear refusals, owner priority only for the owner', () => {
  const now = at('2026-11-02T10:00:00Z');
  const opt = { now, zone: ZONE, by: 'owner' };
  assert.throws(() => normaliseItem({ kind: 'daily' }, opt), /text is required/);
  assert.throws(() => normaliseItem({ kind: 'daily', text: 'x', time: '8:00' }, opt), /HH:MM/);
  assert.throws(() => normaliseItem({ kind: 'weekly', text: 'x', time: '08:00', days: [9] }, opt), /days/);
  assert.throws(() => normaliseItem({ kind: 'interval', text: 'x', every_min: 1 }, opt), /at least 5/);
  assert.throws(() => normaliseItem({ kind: 'once', text: 'x', at: '2020-01-01T00:00:00Z' }, opt), /past/);
  const once = normaliseItem({ text: 'look at the build\nmore', in_minutes: 20, priority: 'owner' }, opt);
  assert.equal(once.kind, 'once');
  assert.equal(once.next, now + 20 * MIN);
  assert.equal(once.title, 'look at the build');
  assert.equal(once.klasse, 'max');
  assert.equal(normaliseItem({ text: 'x', in_minutes: 5, priority: 'owner' }, { ...opt, by: 'agent' }).klasse, 'hintergrund');
});

test('store: add, list in due order, due, fired moves repeating items and drops one-offs', async () => {
  const { s, clock } = store(at('2026-11-02T10:00:00Z'));
  const a = await s.add({ text: 'once', in_minutes: 10 });
  const b = await s.add({ kind: 'interval', text: 'every 30', every_min: 30 });
  assert.deepEqual((await s.list()).items.map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(await s.due(), []);
  clock.t += 31 * MIN;
  const due = await s.due();
  assert.deepEqual(due.map((x) => x.id).sort(), [a.id, b.id].sort());
  await s.fired(due);
  const after = await s.list();
  assert.deepEqual(after.items.map((x) => x.id), [b.id], 'the one-off is gone');
  assert.equal(after.items[0].next, at('2026-11-02T11:00:00Z'));
  assert.equal(after.history.length, 2);
});

test('store: the agent may not remove what the owner planned, and has its own limit', async () => {
  const { s } = store(at('2026-11-02T10:00:00Z'));
  const mine = await s.add({ text: 'owner', in_minutes: 10 }, 'owner');
  await assert.rejects(s.remove(mine.id, 'agent'), /planned by the owner/);
  for (let i = 0; i < AGENDA_LIMITS.byAgent; i += 1) await s.add({ text: `a${i}`, in_minutes: 10 + i }, 'agent');
  await assert.rejects(s.add({ text: 'one more', in_minutes: 5 }, 'agent'), /already planned/);
  assert.equal((await s.remove(mine.id, 'owner')).id, mine.id);
});

test('store: items planned in the same instant stay separate items', async () => {
  const { s } = store(at('2026-11-02T10:00:00Z'));
  const ids = new Set();
  for (let i = 0; i < AGENDA_LIMITS.items; i += 1) {
    const it = await s.add({ text: `o${i}`, in_minutes: 10 + i }, 'owner');
    assert.notEqual(it.existed, true);
    ids.add(it.id);
  }
  assert.equal(ids.size, AGENDA_LIMITS.items);
  assert.equal((await s.list()).items.length, AGENDA_LIMITS.items);
});

test('store: a replayed add with the same id returns the existing item', async () => {
  const { s } = store(at('2026-11-02T10:00:00Z'));
  const first = await s.add({ text: 'x', in_minutes: 10 }, 'agent', 'afixed01');
  const again = await s.add({ text: 'x', in_minutes: 10 }, 'agent', 'afixed01');
  assert.equal(again.existed, true);
  assert.equal(again.next, first.next);
  assert.equal((await s.list()).items.length, 1);
});

test('agendaEvent: id per item and due time, owner class only if planned so, late note', () => {
  const it = { title: 'T', text: 'do', next: 1_000_000, by: 'agent', klasse: 'hintergrund' };
  const e = agendaEvent('a1', it, 1_000_000 + 10 * MIN);
  assert.equal(e.id, 'agenda:a1:1000000');
  assert.equal(e.quelle, 'agenda');
  assert.equal(e.klasse, 'hintergrund');
  assert.match(e.text, /You planned this yourself/);
  assert.match(e.text, /fires late/);
});

test('agendaSource: enqueues what is due once, passes the conformance check', async () => {
  const { s, clock } = store(at('2026-11-02T10:00:00Z'));
  await s.add({ text: 'soon', in_minutes: 1 });
  clock.t += 2 * MIN;
  const seen = [];
  const src = agendaSource({ store: s, enqueue: async (e) => seen.push(e.id), options: { check_s: 1 } });
  src.start();
  await new Promise((r) => setTimeout(r, 50));
  src.stop();
  assert.equal(seen.length, 1);
  assert.equal((await s.list()).items.length, 0);
  const problems = await checkSource((ctx) => agendaSource({ store: s, enqueue: ctx.enqueue }));
  assert.deepEqual(problems, []);
});

test('tools: agenda_plan uses the memo, so a replay plans nothing twice', async () => {
  const { s } = store(at('2026-11-02T10:00:00Z'));
  const [plan, list, cancel] = agendaTools(() => s);
  const memos = new Map();
  const api = { memo: async (k, v) => (memos.has(k) ? memos.get(k) : (memos.set(k, v), v)) };
  const r1 = await plan.execute({ kind: 'once', text: 'check', in_minutes: 15 }, api, {});
  const r2 = await plan.execute({ kind: 'once', text: 'check', in_minutes: 15 }, api, {});
  assert.match(r1.output[0].text, /^Planned a/);
  assert.match(r2.output[0].text, /^Already planned a/);
  assert.match((await list.execute({}, {}, {})).output[0].text, /by agent/);
  const id = r1.details.item.id;
  assert.match((await cancel.execute({ id }, {}, {})).output[0].text, /Cancelled/);
});

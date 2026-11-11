/**
 * The runner's own calendar (src/platform/calendar.js): entries, moving keeps the length, exclusive targets, unreachable sources,
 * reminders once per entry and start.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Bus, TOPICS } from '../src/platform/bus.js';
import { Calendar, calendarClock } from '../src/platform/calendar.js';
import { PlatformStore } from '../src/platform/store.js';
import { TicketError } from '../src/platform/tickets.js';
import { checkSource } from '../src/ports/conformance.js';

const START = Date.parse('2026-11-06T10:00:00Z');
const MIN = 60_000;

function setup() {
  const clock = { t: START };
  const store = new PlatformStore(':memory:');
  const bus = new Bus({ store, now: () => clock.t });
  return { store, bus, clock, calendar: new Calendar({ store, bus, now: () => clock.t }) };
}

const fails = (fn, status, pattern) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof TicketError, `expected TicketError, got ${e}`);
    assert.equal(e.status, status);
    assert.match(e.message, pattern);
    return true;
  });

test('add: needs a start, lasts an hour by default, the end lies after the start', () => {
  const { calendar, bus } = setup();
  fails(() => calendar.add({ title: 'x' }, { actor: 'max' }), 400, /`from` is missing/);
  fails(() => calendar.add({ from: 'morgen' }, { actor: 'max' }), 400, /no time/);
  fails(() => calendar.add({ from: '2026-11-07T10:00:00Z', to: '2026-11-07T09:00:00Z' }, { actor: 'max' }), 400, /does not lie after/);
  const e = calendar.add({ title: ' Wartung ', from: '2026-11-07T10:00:00Z', exklusiv: 'hauptserver', ticket: 'CHG-P1' }, { actor: 'max' });
  assert.equal(e.title, 'Wartung');
  assert.equal(e.to, '2026-11-07T11:00:00.000Z');
  assert.equal(e.exklusiv, 'hauptserver');
  assert.equal(e.ticket, 'CHG-P1');
  assert.equal(e.source, 'planned');
  assert.equal(calendar.get(e.id).title, 'Wartung');
  assert.equal(bus.read({ topic: TOPICS.CALENDAR }).at(-1).data.event, 'created');
});

test('update: only from moves and keeps the length; from and to re-lay; the check holds for both', () => {
  const { calendar } = setup();
  const { id } = calendar.add({ from: '2026-11-07T10:00:00Z', to: '2026-11-07T12:00:00Z' }, { actor: 'max' });
  let e = calendar.update(id, { from: '2026-11-07T15:00:00Z' }, { actor: 'max' });
  assert.equal(e.from, '2026-11-07T15:00:00.000Z');
  assert.equal(e.to, '2026-11-07T17:00:00.000Z');
  e = calendar.update(id, { from: '2026-11-07T15:00:00Z', to: '2026-11-07T15:30:00Z' }, { actor: 'max' });
  assert.equal(e.to, '2026-11-07T15:30:00.000Z');
  fails(() => calendar.update(id, { to: '2026-11-07T14:00:00Z' }, { actor: 'max' }), 400, /does not lie after/);
  fails(() => calendar.update('k0', { title: 'x' }, { actor: 'max' }), 404, /no calendar entry/);
  assert.equal(calendar.get(id).to, '2026-11-07T15:30:00.000Z');
});

test('window: what overlaps, in order; limits; a source that cannot be read is named', () => {
  const { calendar } = setup();
  const a = calendar.add({ title: 'A', from: '2026-11-07T10:00:00Z', to: '2026-11-07T11:00:00Z' }, { actor: 'max' });
  const b = calendar.add({ title: 'B', from: '2026-11-06T23:00:00Z', to: '2026-11-07T01:00:00Z' }, { actor: 'max' });
  calendar.add({ title: 'Später', from: '2026-12-24T10:00:00Z' }, { actor: 'max' });
  const w = calendar.window({ from: '2026-11-07T00:00:00Z', to: '2026-11-08T00:00:00Z' });
  assert.deepEqual(w.entries.map((e) => e.id), [b.id, a.id]);
  assert.equal(w.complete, true);
  fails(() => calendar.window({ from: '2026-11-08T00:00:00Z', to: '2026-11-07T00:00:00Z' }), 400, /does not lie after/);
  fails(() => calendar.window({ from: '2026-01-01T00:00:00Z', to: '2028-01-01T00:00:00Z' }), 400, /limited/);
  calendar.unreachable = () => [{ source: 'icloud', reason: 'timeout' }];
  const partial = calendar.window({ from: '2026-11-07T00:00:00Z', to: '2026-11-08T00:00:00Z' });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.unreachable, [{ source: 'icloud', reason: 'timeout' }]);
});

test('busy: taken only inside the entry and only for its target; a read error is unknown, never free', () => {
  const { calendar, store } = setup();
  calendar.add({ title: 'Lasttest', from: '2026-11-07T10:00:00Z', to: '2026-11-07T11:00:00Z', exklusiv: 'hauptserver' }, { actor: 'max' });
  const inside = calendar.busy('hauptserver', '2026-11-07T10:30:00Z');
  assert.equal(inside.busy, true);
  assert.equal(inside.by.title, 'Lasttest');
  assert.equal(calendar.busy('hauptserver', '2026-11-07T11:30:00Z').busy, false);
  assert.equal(calendar.busy('truenas', '2026-11-07T10:30:00Z').busy, false);
  fails(() => calendar.busy(' '), 400, /target/);
  store.close();
  const broken = calendar.busy('hauptserver');
  assert.equal(broken.busy, null);
  assert.equal(broken.unknown, true);
});

test('remind: at the right time, once per entry and start; a moved entry reminds again; none without remind_min', () => {
  const { calendar, clock, bus } = setup();
  const e = calendar.add({ title: 'Call', from: new Date(START + 60 * MIN).toISOString(), remind_min: 15, ticket: 'VOR-P3' }, { actor: 'max' });
  calendar.add({ title: 'Still', from: new Date(START + 60 * MIN).toISOString() }, { actor: 'max' });
  assert.equal(calendar.remind(), 0);
  clock.t = START + 44 * MIN;
  assert.equal(calendar.remind(), 0);
  clock.t = START + 45 * MIN;
  assert.equal(calendar.remind(), 1);
  assert.equal(calendar.remind(), 0);
  const inbox = bus.read({ topic: TOPICS.INBOX });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].ref, 'VOR-P3');
  assert.equal(inbox[0].class, 'hintergrund');
  assert.match(inbox[0].text, /Call/);
  calendar.update(e.id, { from: new Date(START + 50 * MIN).toISOString() }, { actor: 'max' });
  assert.equal(calendar.remind(), 1);
  clock.t = START + 120 * MIN;
  assert.equal(calendar.remind(), 0, 'nothing for what has started already');
});

test('once: a repeated request acts once', () => {
  const { calendar } = setup();
  const first = calendar.once('r1', () => calendar.add({ title: 'x', from: '2026-11-07T10:00:00Z' }, { actor: 'agent' }));
  const again = calendar.once('r1', () => calendar.add({ title: 'x', from: '2026-11-07T10:00:00Z' }, { actor: 'agent' }));
  assert.equal(again.id, first.id);
  assert.equal(calendar.window({ from: '2026-11-07T00:00:00Z', to: '2026-11-08T00:00:00Z' }).entries.length, 1);
});

test('calendarClock: passes the source contract', async () => {
  const { calendar } = setup();
  assert.deepEqual(await checkSource(() => calendarClock({ calendar })), []);
});

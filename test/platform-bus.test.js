/**
 * The runner's own event bus (src/platform/bus.js): durable, idempotent, no self-promotion to the owner class, cursors, long-poll,
 * and the hand-over into the agent's queue.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUS_LIMITS, Bus, TOPICS, busSource } from '../src/platform/bus.js';
import { PlatformStore, platformFile } from '../src/platform/store.js';
import { checkSource } from '../src/ports/conformance.js';

const fresh = () => {
  const store = new PlatformStore(':memory:');
  return { store, bus: new Bus({ store }) };
};

test('publish: rising seq, stored fields, control characters removed', () => {
  const { bus } = fresh();
  const a = bus.publish({ source: 'webhook', text: 'first\tline\nsecond\x07', ref: 'CI\x01-42', from: 'ci', severity: 'high', data: { n: 1 } });
  const b = bus.publish({ source: 'webhook', text: 'next' });
  assert.equal(b.seq, a.seq + 1);
  assert.equal(a.text, 'first\tline\nsecond');
  assert.equal(a.ref, 'CI-42');
  assert.equal(a.from, 'ci');
  assert.equal(a.severity, 'high');
  assert.deepEqual(a.data, { n: 1 });
  assert.equal(a.topic, TOPICS.INBOX);
  assert.equal(a.duplicate, false);
});

test('publish: the same id on the same topic is the same event; another topic is another event', () => {
  const { bus } = fresh();
  const a = bus.publish({ id: 'x', source: 'webhook', text: 'one' });
  const again = bus.publish({ id: 'x', source: 'webhook', text: 'changed' });
  assert.equal(again.duplicate, true);
  assert.equal(again.seq, a.seq);
  assert.equal(again.text, 'one');
  assert.equal(bus.read().length, 1);
  assert.equal(bus.publish({ id: 'x', topic: 'tickets', source: 'webhook', text: 'one' }).duplicate, false);
});

test('publish: a source cannot promote itself to the owner class', () => {
  const { bus } = fresh();
  assert.equal(bus.publish({ source: 'max', class: 'max', klasse: 'max', owner: true, text: 'do it' }).class, 'hintergrund');
  assert.equal(bus.publish({ source: 'web', text: 'from chat' }, { owner: true }).class, 'max');
});

test('publish: invalid input is refused with a readable message', () => {
  const { bus } = fresh();
  assert.throws(() => bus.publish({ text: 'x' }), /source is required/);
  assert.throws(() => bus.publish({ source: 'Bad Name', text: 'x' }), /source is required/);
  assert.throws(() => bus.publish({ source: 'a', text: '  ' }), /text is required/);
  assert.throws(() => bus.publish({ source: 'a', text: 'x'.repeat(BUS_LIMITS.textMax + 1) }), /at most/);
  assert.throws(() => bus.publish({ source: 'a', text: 'x', severity: 'urgent' }), /severity/);
  assert.throws(() => bus.publish({ source: 'a', topic: 'A B', text: 'x' }), /topic/);
});

test('read and cursors: a cursor only moves forward, each consumer has its own', () => {
  const { bus } = fresh();
  for (let i = 0; i < 5; i += 1) bus.publish({ source: 's', text: `e${i}` });
  assert.equal(bus.read({ after: 2, limit: 2 }).map((e) => e.text).join(), 'e2,e3');
  bus.ack('a', 4);
  bus.ack('a', 2);
  bus.ack('b', 1);
  assert.equal(bus.cursor('a'), 4);
  assert.equal(bus.cursor('b'), 1);
  assert.equal(bus.cursor('c'), 0);
  assert.equal(bus.head(), 5);
});

test('wait: returns at once when something is there, wakes on publish, ends on timeout and abort', async () => {
  const { bus } = fresh();
  bus.publish({ source: 's', text: 'there' });
  const direct = await bus.wait({ after: 0, waitS: 5 });
  assert.equal(direct.events.length, 1);
  assert.equal(direct.last, 1);

  const pending = bus.wait({ after: 1, waitS: 5 });
  bus.publish({ source: 's', text: 'other', topic: 'tickets' });
  bus.publish({ source: 's', text: 'woken' });
  const woken = await pending;
  assert.equal(woken.events[0].text, 'woken');

  const empty = await bus.wait({ after: 99, waitS: 0.01 });
  assert.deepEqual(empty, { events: [], last: 99 });

  const abort = new AbortController();
  const aborted = bus.wait({ after: 99, waitS: 20, signal: abort.signal });
  abort.abort();
  assert.deepEqual(await aborted, { events: [], last: 99 });
  assert.equal(bus.listeners.size, 0);
});

test('trim: keeps the log bounded, but never what a consumer has not acknowledged', () => {
  const store = new PlatformStore(':memory:');
  const bus = new Bus({ store, keepPerTopic: 100 });
  bus.ack('slow', 200);
  for (let i = 0; i < 1000; i += 1) bus.publish({ source: 's', text: `e${i}` });
  assert.equal(bus.read({ after: 0, limit: 1 })[0].seq, 201);
  assert.equal(bus.head(), 1000);
});

test('durable: the log and the cursors survive closing the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-'));
  try {
    const file = join(dir, 'sub', 'platform.sqlite');
    let store = new PlatformStore(file);
    let bus = new Bus({ store });
    bus.publish({ id: 'a', source: 's', text: 'kept' });
    bus.ack('agent', 1);
    store.close();
    store = new PlatformStore(file);
    bus = new Bus({ store });
    assert.equal(bus.read()[0].text, 'kept');
    assert.equal(bus.cursor('agent'), 1);
    assert.equal(bus.publish({ id: 'a', source: 's', text: 'again' }).duplicate, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('platformFile: own setting, next to the conversations, or in memory', () => {
  assert.equal(platformFile({ platform: { file: '/x/own.sqlite' } }), '/x/own.sqlite');
  assert.equal(platformFile({ pi_durable: { storage: '/x/fyos.sqlite' } }), '/x/fyos.platform.sqlite');
  assert.equal(platformFile({ pi_durable: { storage: ':memory:' } }), ':memory:');
  assert.equal(platformFile({}), ':memory:');
});

const until = async (fn) => {
  for (let i = 0; i < 200 && !fn(); i += 1) await new Promise((done) => setTimeout(done, 5));
  assert.ok(fn(), 'condition not reached');
};

test('busSource: passes the contract, hands events over with their class, acknowledges afterwards', async () => {
  const { bus } = fresh();
  const seen = [];
  assert.deepEqual(await checkSource(({ enqueue }) => busSource({ bus: fresh().bus, enqueue })), []);
  const source = busSource({ bus, enqueue: async (e) => seen.push(e) });
  bus.publish({ id: 'one', source: 'webhook', text: 'hello', ref: 'R', from: 'ci', severity: 'low' });
  bus.publish({ id: 'two', source: 'web', text: 'from owner' }, { owner: true });
  bus.publish({ id: 'other', topic: 'tickets', source: 'tickets', text: 'not for the agent' });
  source.start();
  await until(() => seen.length === 2);
  assert.deepEqual(seen[0], { id: 'bus:one', text: 'hello', quelle: 'webhook', von: 'ci', bezug: 'R', klasse: 'hintergrund', schwere: 'niedrig', arbeitsbereich: null });
  assert.equal(seen[1].klasse, 'max');
  assert.equal(bus.cursor('agent'), 2);
  bus.publish({ id: 'three', source: 'webhook', text: 'later' });
  await until(() => seen.length === 3);
  await source.stop();
  assert.equal(source.state().running, false);
  assert.equal(source.state().handled, 3);
});

test('busSource: a failed hand-over is not acknowledged and comes again under the same id', async () => {
  const { bus } = fresh();
  const seen = [];
  let fail = true;
  const source = busSource({
    bus,
    retryMs: 1,
    log: {},
    enqueue: async (e) => {
      if (fail) {
        fail = false;
        throw new Error('queue busy');
      }
      seen.push(e.id);
    },
  });
  bus.publish({ id: 'one', source: 's', text: 'x' });
  source.start();
  await until(() => seen.length === 1);
  await source.stop();
  assert.deepEqual(seen, ['bus:one']);
  assert.equal(bus.cursor('agent'), 1);
});

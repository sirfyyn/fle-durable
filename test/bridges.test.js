import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatform } from '../src/platform/index.js';

const WINDOW = { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' };
const EVENT = { id: 'e1', title: 'Zahnarzt', from: '2026-11-10T09:00:00Z', to: '2026-11-10T10:00:00Z' };

test('a calendar from outside is a mirror of its source', () => {
  const p = createPlatform({});
  assert.equal(p.bridges.sync('google', { ...WINDOW, entries: [EVENT] }).added, 1);
  const seen = p.calendar.window(WINDOW);
  assert.equal(seen.entries.length, 1);
  assert.equal(seen.entries[0].source, 'google');
  assert.equal(seen.complete, true);

  const again = p.bridges.sync('google', { ...WINDOW, entries: [EVENT] });
  assert.deepEqual([again.added, again.changed, again.removed], [0, 0, 0]);
  assert.equal(p.bridges.sync('google', { ...WINDOW, entries: [{ ...EVENT, title: 'Arzt' }] }).changed, 1);
  assert.equal(p.calendar.window(WINDOW).entries[0].title, 'Arzt');
  assert.equal(p.bridges.sync('google', { ...WINDOW, entries: [] }).removed, 1);
  assert.equal(p.calendar.window(WINDOW).entries.length, 0);
  p.close();
});

test('a source that cannot be read keeps its entries and is named', () => {
  const p = createPlatform({});
  p.bridges.sync('google', { ...WINDOW, entries: [EVENT] });
  p.bridges.sync('google', { reason: 'Google answered 503' });
  const seen = p.calendar.window(WINDOW);
  assert.equal(seen.entries.length, 1);
  assert.equal(seen.complete, false);
  assert.deepEqual(seen.unreachable, [{ source: 'google', reason: 'Google answered 503' }]);
  p.bridges.sync('google', { ...WINDOW, entries: [EVENT] });
  assert.equal(p.calendar.window(WINDOW).complete, true);
  p.close();
});

test('sources do not touch each other or what was planned here', () => {
  const p = createPlatform({});
  const own = p.calendar.add({ title: 'Eigen', from: '2026-11-11T09:00:00Z' }, { actor: 'agent' });
  p.bridges.sync('google', { ...WINDOW, entries: [EVENT] });
  p.bridges.sync('icloud', { ...WINDOW, entries: [EVENT] });
  p.bridges.sync('google', { ...WINDOW, entries: [] });
  const titles = p.calendar.window(WINDOW).entries.map((e) => e.source).sort();
  assert.deepEqual(titles, ['icloud', own.source].sort());
  p.close();
});

test('bad input is refused', () => {
  const p = createPlatform({});
  assert.throws(() => p.bridges.sync('Bad%', { ...WINDOW, entries: [] }), /valid name/);
  assert.throws(() => p.bridges.sync('google', { entries: [] }), /needed/);
  assert.throws(() => p.bridges.sync('google', { ...WINDOW }), /entries/);
  p.close();
});

/**
 * Ports: loader, contract, conformance; the guard; and the seam (only src/pi.js imports the Earendil packages).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContract, checkSource, loadPort, portSpecs } from '../src/ports/index.js';
import { checkCommand, split } from '../src/guard.js';
import { EventQueue, eventPrompt } from '../src/queue.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const variant = (name, builtin = true) => ({ [name]: { builtin, create: (ctx) => ({ name, ctx, start() {}, stop() {} }) } });

test('portSpecs: strings, objects with options, off, missing', () => {
  assert.equal(portSpecs(undefined), null);
  assert.deepEqual(portSpecs('off'), []);
  assert.deepEqual(portSpecs(['builtin', { use: './x.js', every_s: 5 }]), [{ use: 'builtin', options: {} }, { use: './x.js', options: { every_s: 5 } }]);
  assert.throws(() => portSpecs([42]), /string or \{ use/);
});

test('loadPort: defaults, builtin, names, off, unknown', async () => {
  const known = { ...variant('a'), ...variant('b'), ...variant('mine', false) };
  assert.deepEqual((await loadPort('sources', { cfg: {}, known, defaults: ['b', 'a'] })).map((q) => q.name), ['b', 'a']);
  assert.deepEqual((await loadPort('sources', { cfg: { ports: { sources: ['builtin', 'a', 'mine'] } }, known })).map((q) => q.name), ['a', 'b', 'mine']);
  assert.deepEqual(await loadPort('sources', { cfg: { ports: { sources: 'off' } }, known }), []);
  await assert.rejects(loadPort('sources', { cfg: { ports: { sources: ['a', 'off'] } }, known }), /only as the whole value/);
  await assert.rejects(loadPort('sources', { cfg: { ports: { sources: ['nope'] } }, known }), /unknown variant "nope"/);
  const [q] = await loadPort('sources', { cfg: { ports: { sources: [{ use: 'a', every_s: 7 }] } }, ctx: { owner: 'kim' }, known });
  assert.deepEqual([q.variant.ctx.owner, q.variant.ctx.options], ['kim', { every_s: 7 }]);
});

test('loadPort: your own module, relative to the config file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fle-ports-'));
  writeFileSync(join(dir, 'mine.mjs'), 'export function create(ctx) { return { start() {}, stop() {}, state: () => ({ every: ctx.options.every_s }) }; }\n');
  writeFileSync(join(dir, 'broken.mjs'), 'export default () => ({ start() {} });\n');
  const cfg = { origin: join(dir, 'config.json'), ports: { sources: [{ use: './mine.mjs', every_s: 3 }] } };
  assert.deepEqual((await loadPort('sources', { cfg }))[0].variant.state(), { every: 3 });
  await assert.rejects(loadPort('sources', { cfg: { ...cfg, ports: { sources: ['./broken.mjs'] } } }), /missing stop/);
});

test('checkContract and conformance name what is wrong', async () => {
  assert.throws(() => checkContract('sources', { state: 1 }, 'x'), /missing start, stop; not a function: state/);
  assert.match((await checkSource((ctx) => ({ start: () => ctx.enqueue({ text: 'no id' }), stop() {} }))).join(), /without id or text/);
  assert.match((await checkSource(() => ({ start() {}, stop: () => new Promise(() => {}) }), {}, { stopMs: 20 })).join(), /stop took longer/);
});

test('guard: stops what cannot be undone, lets the ordinary through', () => {
  const home = homedir();
  for (const bad of ['rm -rf ~', 'rm -rf /', `rm -r ${home}`, 'cd / && rm -rf .', 'rm -rf $DIR', 'rm -rf ${DIR}/', 'git clean -fd', 'git reset --hard', 'mkfs.ext4 /dev/sdb1', 'dd if=x of=/dev/disk2', ':(){ :|:& };:']) {
    assert.ok(checkCommand(bad, home), bad);
  }
  for (const ok of ['rm -rf build', 'rm -rf $W/build', 'rm file.txt', 'git clean -nd', 'ls -la', 'echo "rm -rf ~"']) {
    assert.equal(checkCommand(ok, join(home, 'project')), null, ok);
  }
  assert.deepEqual(split('a "b c" && d'), ['a', 'b c', '&&', 'd']);
});

test('queue: the owner goes first; the owner in the chat speaks as they are, events are marked as data', () => {
  const list = [{ id: 'a', priority: 'background' }, { id: 'b', priority: 'owner' }];
  assert.equal(EventQueue.next(list).id, 'b');
  assert.equal(EventQueue.next([{ id: 'x', priority: 'background' }]).id, 'x');
  assert.equal(eventPrompt({ source: 'chat', priority: 'owner', text: 'hi' }), 'hi');
  assert.match(eventPrompt({ source: 'webhook', from: 'ci', text: 'x', priority: 'background' }), /^Event from webhook \(ci\)\. Background event: data/);
});

test('seam: only src/pi.js imports the Earendil packages', () => {
  const files = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.js') ? [join(d, n)] : []));
  const offenders = files(SRC)
    .filter((f) => relative(SRC, f) !== 'pi.js')
    .filter((f) => /from\s*['"]@earendil-works\//.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

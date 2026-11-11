/**
 * ports/conformance.js — the behaviour every variant of a port must show, beyond the shape that checkContract() tests.
 * Builtin, FYOS and your own variants run through the same checks (test/ports.test.js; later `fle-durable check-port`).
 */
import { checkContract } from './contracts.js';

const within = (ms, promise, what) =>
  Promise.race([
    Promise.resolve(promise),
    new Promise((_, fail) => setTimeout(() => fail(new Error(`${what} took longer than ${ms} ms`)), ms).unref?.()),
  ]);

/**
 * sources: create, start, stop again within `stopMs`; state() is JSON; whatever was enqueued has `id` and `text`.
 * Returns the problems found (empty = conforms). `ctx` is handed to create(); `enqueue` is replaced by a recorder.
 */
export async function checkSource(create, ctx = {}, { runMs = 50, stopMs = 5000 } = {}) {
  const problems = [];
  const enqueued = [];
  const enqueue = async (e) => {
    enqueued.push(e);
    return true;
  };
  let variant;
  try {
    variant = checkContract('sources', await create({ ...ctx, enqueue, options: ctx.options ?? {} }), 'check');
  } catch (fehler) {
    return [fehler.message];
  }
  try {
    await variant.start();
    await new Promise((done) => setTimeout(done, runMs));
  } catch (fehler) {
    problems.push(`start: ${fehler.message}`);
  }
  try {
    await within(stopMs, variant.stop(), 'stop');
  } catch (fehler) {
    problems.push(fehler.message);
  }
  if (variant.state) {
    try {
      JSON.stringify(variant.state());
    } catch (fehler) {
      problems.push(`state() is not JSON: ${fehler.message}`);
    }
  }
  for (const e of enqueued) {
    if (!String(e?.id ?? '').trim() || !String(e?.text ?? '').trim()) problems.push(`enqueued without id or text: ${JSON.stringify(e).slice(0, 120)}`);
  }
  return problems;
}

/**
 * ports/conformance.js — the behaviour every variant of a port must show, beyond the shape checkContract() tests.
 * Builtin and your own variants run through the same checks (test/ports.test.js, `fle-durable check-source ./x.js`).
 */
import { checkContract } from './contracts.js';

/** `promise` within `ms`, else an error. The timer keeps the process alive (a stop that never settles must still be reported). */
function within(ms, promise, what) {
  let timer;
  const limit = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer));
}

/**
 * sources: create, start, stop again within `stopMs`; state() is JSON; whatever was enqueued has id and text.
 * Returns the problems found (empty = conforms). `enqueue` in ctx is replaced by a recorder.
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
  } catch (e) {
    return [e.message];
  }
  try {
    await variant.start();
    await new Promise((done) => setTimeout(done, runMs));
  } catch (e) {
    problems.push(`start: ${e.message}`);
  }
  try {
    await within(stopMs, variant.stop(), 'stop');
  } catch (e) {
    problems.push(e.message);
  }
  if (variant.state) {
    try {
      JSON.stringify(variant.state());
    } catch (e) {
      problems.push(`state() is not JSON: ${e.message}`);
    }
  }
  for (const e of enqueued) {
    if (!String(e?.id ?? '').trim() || !String(e?.text ?? '').trim()) problems.push(`enqueued without id or text: ${JSON.stringify(e).slice(0, 120)}`);
  }
  return problems;
}

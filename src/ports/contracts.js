/**
 * ports/contracts.js — the contracts of FLE Durable's ports.
 *
 * Every place where the agent asks something outside itself is a port. A port is filled by a builtin variant, switched
 * off, or filled by your own module. All variants pass the same check, so the runner never needs to know which one it got.
 *
 * sources — something that puts events into the durable queue.
 *   create(ctx), ctx = { cfg, harness, enqueue, owner, options, log }
 *   enqueue({ id, text, source, from?, ref?, priority? }) is idempotent by id; priority 'owner' only for what the owner sent.
 *   start(), stop(); optional: state() for the status page, onTurn(event) right before a queued event reaches the agent.
 */
export const PORTS = Object.freeze({
  sources: Object.freeze({ many: true, methods: ['start', 'stop'], optional: ['state', 'onTurn'] }),
});

/** Check one variant against its contract; names every missing piece in one message, so a broken module fails at start. */
export function checkContract(port, variant, name = '?') {
  const contract = PORTS[port];
  if (!contract) throw new Error(`unknown port "${port}"`);
  if (!variant || typeof variant !== 'object') throw new Error(`${port}/${name}: create() must return an object`);
  const missing = contract.methods.filter((m) => typeof variant[m] !== 'function');
  const wrong = contract.optional.filter((m) => variant[m] !== undefined && typeof variant[m] !== 'function');
  if (missing.length || wrong.length) {
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.join(', ')}`);
    if (wrong.length) parts.push(`not a function: ${wrong.join(', ')}`);
    throw new Error(`${port}/${name}: ${parts.join('; ')}`);
  }
  return variant;
}

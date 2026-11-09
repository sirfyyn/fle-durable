/**
 * ports/contracts.js — the contracts of FLE Durable's ports (docs/current/FLE-DURABLE-ANSCHLUESSE.md).
 *
 * Every place where the runner asks something outside itself is a port. A port is filled by a builtin variant, switched
 * off, or filled by your own module. All variants (builtin, FYOS, yours) pass the same contract check, so the runner never
 * needs to know which one it got.
 *
 * Wired so far: `sources`. The other ports follow in step 2 (FYOS variants behind the contract) and step 3 (builtins).
 */

/** The class that has right of way and decides approvals. The stored value stays `max` until the extraction (Wartend, hub stream). */
export const OWNER_CLASS = 'max';
export const BACKGROUND_CLASS = 'hintergrund';

/** Is this event from the owner (right of way, may steer a running turn)? */
export function isOwnerClass(klasse) {
  return klasse === OWNER_CLASS;
}

/** Normalise a class to one of the two known ones; anything unknown is background. */
export function eventClass(klasse) {
  return isOwnerClass(klasse) ? OWNER_CLASS : BACKGROUND_CLASS;
}

/** The owner's name (lower case) as it appears in chats, tickets and comments. Config `owner`, FYOS sets `max`. */
export function ownerName(cfg) {
  return String(cfg?.owner || cfg?.itsm?.besitzer || 'owner').trim().toLowerCase();
}

/**
 * Contracts. `methods`: required functions; `optional`: functions the runner calls if present.
 *
 * sources — something that puts events into the durable queue.
 *   create(ctx) with ctx = { cfg, hub, harness, enqueue, owner, log }
 *   enqueue({ id, text, quelle, von, bezug, klasse, schwere }) is idempotent by `id`.
 *   start(), stop(); optional: state() for the control channel, onTurn(entry) right before a queued entry reaches the agent.
 */
export const PORTS = Object.freeze({
  sources: Object.freeze({ many: true, methods: ['start', 'stop'], optional: ['state', 'onTurn'] }),
});

/**
 * Check one variant against its contract. Throws with every missing piece in one message, so a broken module fails at start
 * and not at the first event.
 */
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

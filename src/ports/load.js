/**
 * ports/load.js — fill the ports from the config.
 *
 * Config key `ports.<port>`; for a port with `many`, a list. Each entry is one of:
 *   "builtin"            every builtin variant of the port
 *   "off"                nothing (only as the whole value)
 *   "<name>"             a variant registered by the start file
 *   "./my-source.js"     your module, relative to the config file; absolute paths work too
 *   { "use": <one of the above>, ...options }   the same, with options handed to create() as `ctx.options`
 *
 * A module exports `create(ctx)` (or a default function) and returns an object that passes the port's contract.
 */
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PORTS, checkContract } from './contracts.js';

const isPath = (s) => s.startsWith('./') || s.startsWith('../') || isAbsolute(s);

/** Turn the config value into a flat list of `{ use, options }`; null when the config says nothing. */
export function portSpecs(value, { many = true } = {}) {
  if (value === undefined || value === null) return null;
  if (value === 'off' || value === false) return [];
  const list = Array.isArray(value) ? value : [value];
  if (!many && list.length > 1) throw new Error(`this port takes one variant, got ${list.length}`);
  return list.map((entry) => {
    if (typeof entry === 'string') return { use: entry.trim(), options: {} };
    if (entry && typeof entry === 'object' && typeof entry.use === 'string') {
      const { use, ...options } = entry;
      return { use: use.trim(), options };
    }
    throw new Error(`port entry must be a string or { use, ... }: ${JSON.stringify(entry)}`);
  });
}

async function importCreate(path, base) {
  const file = isAbsolute(path) ? path : resolve(base, path);
  const mod = await import(pathToFileURL(file).href);
  const create = mod.create ?? mod.default;
  if (typeof create !== 'function') throw new Error(`${path}: exports neither create() nor a default function`);
  return create;
}

/**
 * Load the variants of one port, in config order.
 * @param known     { name: { create, builtin } }
 * @param defaults  used when the config has no entry for this port
 */
export async function loadPort(port, { cfg, ctx = {}, known = {}, defaults = ['builtin'] } = {}) {
  const contract = PORTS[port];
  if (!contract) throw new Error(`unknown port "${port}"`);
  const specs = portSpecs(cfg?.ports?.[port], contract) ?? portSpecs(defaults, contract);
  const base = cfg?.origin ? dirname(cfg.origin) : process.cwd();
  const expanded = [];
  for (const s of specs) {
    if (s.use === 'off') throw new Error(`ports.${port}: "off" only as the whole value`);
    if (s.use === 'builtin') {
      for (const [name, k] of Object.entries(known)) if (k.builtin) expanded.push({ name, create: k.create, options: s.options });
    } else if (isPath(s.use)) {
      expanded.push({ name: s.use, create: await importCreate(s.use, base), options: s.options });
    } else if (known[s.use]) {
      expanded.push({ name: s.use, create: known[s.use].create, options: s.options });
    } else {
      throw new Error(`ports.${port}: unknown variant "${s.use}" (known: ${Object.keys(known).join(', ') || 'none'}; modules start with ./ or /)`);
    }
  }
  const seen = new Set();
  const out = [];
  for (const e of expanded) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({ name: e.name, variant: checkContract(port, await e.create({ ...ctx, options: e.options }), e.name) });
  }
  return out;
}

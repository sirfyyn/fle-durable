/**
 * config.js — one JSON file (optional) plus the environment; the environment wins.
 *
 *   FLE_DURABLE_CONFIG      path of the JSON file (or --config <file>)
 *   FLE_DURABLE_HOME        data folder (default ~/.fle-durable): SQLite file, work folder
 *   FLE_DURABLE_HOST/PORT   where the API listens (default 127.0.0.1:8740; loopback only unless `allowNetwork`)
 *   FLE_DURABLE_TOKEN       API token, at least 32 characters (required)
 *   FLE_DURABLE_MODEL_URL   OpenAI-compatible base URL (default http://127.0.0.1:8080/v1)
 *   FLE_DURABLE_MODEL       model id the server knows (default "local")
 *   FLE_DURABLE_MODEL_KEY   API key if the server wants one
 *   FLE_DURABLE_CONTEXT     context window in tokens (default 32768)
 *   FLE_DURABLE_WORKSPACE   the agent's working folder (default <home>/work)
 *   FLE_DURABLE_HUB_URL     an MCP hub (FYOS fyos-hub): its tools through hub_search / hub_call (src/hub.js)
 *   FLE_DURABLE_HUB_HEADERS JSON object of headers for the hub (its token, X-GitHub-Token); never shown to the model
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
const str = (v, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);
const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

export function configPath(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--config');
  return str(i >= 0 ? argv[i + 1] : undefined, str(env.FLE_DURABLE_CONFIG));
}

/** Load and normalise. `source` is a path, an object (tests) or empty. Throws with a clear message on a broken file. */
export function loadConfig(source = configPath(), env = process.env) {
  let file = {};
  let origin = null;
  if (typeof source === 'string' && source) {
    origin = resolve(expand(source));
    if (existsSync(origin)) {
      try {
        file = JSON.parse(readFileSync(origin, 'utf8'));
      } catch (e) {
        throw new Error(`config ${origin} is not valid JSON: ${e.message}`);
      }
      if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`config ${origin} must be an object`);
    }
  } else if (source && typeof source === 'object') {
    file = source;
  }
  const home = resolve(expand(str(env.FLE_DURABLE_HOME, str(file.home, join(homedir(), '.fle-durable')))));
  const rel = (p) => (isAbsolute(expand(p)) ? expand(p) : resolve(origin ? dirname(origin) : home, p));
  const m = file.model ?? {};
  const window = Math.max(4096, num(env.FLE_DURABLE_CONTEXT, num(m.contextWindow, 32768)));
  return {
    origin,
    home,
    host: str(env.FLE_DURABLE_HOST, str(file.host, '127.0.0.1')),
    port: num(env.FLE_DURABLE_PORT, num(file.port, 8740)),
    allowNetwork: file.allowNetwork === true,
    token: str(env.FLE_DURABLE_TOKEN, str(file.token)),
    storage: rel(str(file.storage, join(home, 'durable.sqlite'))),
    workspace: rel(str(env.FLE_DURABLE_WORKSPACE, str(file.workspace, join(home, 'work')))),
    agent: str(file.agent, 'agent'),
    owner: str(file.owner, 'owner').toLowerCase(),
    instructions: str(file.instructions),
    model: {
      provider: 'local',
      name: str(m.name, 'Local model'),
      baseUrl: str(env.FLE_DURABLE_MODEL_URL, str(m.baseUrl, 'http://127.0.0.1:8080/v1')).replace(/\/+$/, ''),
      apiKey: str(env.FLE_DURABLE_MODEL_KEY, str(m.apiKey, 'local')),
      modelId: str(env.FLE_DURABLE_MODEL, str(m.id, 'local')),
      contextWindow: window,
      maxTokens: Math.max(256, Math.min(num(m.maxTokens, Math.floor(window / 4)), Math.floor(window / 2))),
    },
    events: { enabled: file.events?.enabled !== false && env.FLE_DURABLE_EVENTS !== '0' },
    hub: { url: str(env.FLE_DURABLE_HUB_URL, str(file.hub?.url)), headers: hubHeaders(env.FLE_DURABLE_HUB_HEADERS, file.hub?.headers) },
    ports: file.ports ?? {},
    agenda: { zone: str(file.agenda?.zone, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'), check_s: num(file.agenda?.check_s, 15) },
    limits: { bodyBytes: num(file.limits?.bodyBytes, 2 * 1024 * 1024), historyEntries: num(file.limits?.historyEntries, 400) },
  };
}

/** May the API listen like this? Loopback by default, a network address only with allowNetwork, never a wildcard. */
export function bindingProblem(cfg) {
  if (String(cfg.token ?? '').length < 32) return 'FLE_DURABLE_TOKEN is required (at least 32 characters): the agent runs commands';
  const loop = ['127.0.0.1', '::1', 'localhost'].includes(cfg.host);
  if (loop) return null;
  if (['', '0.0.0.0', '::', '[::]'].includes(cfg.host)) return 'no wildcard binding; name the address of this machine';
  if (!cfg.allowNetwork) return `${cfg.host} is not loopback; set "allowNetwork": true in the config to listen there`;
  return null;
}

/** What may be shown (no token, no key). */
export function publicView(cfg) {
  return {
    agent: cfg.agent,
    model: { name: cfg.model.name, id: cfg.model.modelId, baseUrl: cfg.model.baseUrl, contextWindow: cfg.model.contextWindow },
    storage: cfg.storage,
    workspace: cfg.workspace,
    events: cfg.events.enabled,
    zone: cfg.agenda.zone,
  };
}

/** Headers for the hub: a JSON object of strings (from the environment or the file); anything else is ignored. */
function hubHeaders(text, fromFile) {
  let v = fromFile;
  if (text) {
    try {
      v = JSON.parse(text);
    } catch {
      v = null;
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => typeof x === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(k)));
}

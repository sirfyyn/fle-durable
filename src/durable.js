#!/usr/bin/env node
/**
 * durable.js — FLE Durable: the local runner plus its event machinery, without FYOS (docs/current/FLE-DURABLE-ANSCHLUESSE.md).
 *
 *   FYOS_RUNNER_TOKEN=… FYOS_RUNNER_PORT=… FYOS_MODELL_BASIS_URL=http://127.0.0.1:8080/v1 node src/durable.js [--config file]
 *
 * Like src/lokal.js (loopback only, token required, no hub unless one is configured) and in addition:
 *   - the durable queue (ingress.js) without a hub stream: only sources enqueue;
 *   - sources from `ports.sources`, default ["agenda"] (src/ports/sources.js; "builtin" takes all builtins);
 *   - the agenda: the owner plans in the app or over HTTP, the agent plans with agenda_plan;
 *   - the webhook `POST /api/events` and the queue `GET /api/queue`.
 * FLE Link starts it as its agent plugin (flelink: web/plugins/agent, crates/flelink-api/src/agent.rs).
 */
import { pathToFileURL } from 'node:url';
import { bindungPruefen, konfigurationLaden, oeffentlicheSicht } from './config.js';
import { spracheSetzen } from './i18n.js';
import { Ingress } from './ingress.js';
import { Runner } from './runner.js';
import { erstelleServer } from './server.js';
import { loadPort } from './ports/load.js';
import { ownerName } from './ports/contracts.js';
import { builtinSources } from './ports/sources.js';

export const DURABLE_DEFAULT_SOURCES = Object.freeze(['agenda', 'bus', 'tickets', 'calendar']);

/**
 * The config as FLE Durable runs it: local mode, events on (FYOS_RUNNER_PROAKTIV=0 turns them off), agenda on unless the file
 * sets `agenda.an: false`.
 */
export function durableKonfiguration(env = process.env, quelle = undefined) {
  const cfg = konfigurationLaden(quelle, { FYOS_RUNNER_PROAKTIV: '1', ...env, FYOS_RUNNER_LOKAL: '1' });
  cfg.agenda = { an: true, ...(cfg.agenda ?? {}) };
  cfg.platform = { an: true, ...(cfg.platform ?? {}) };
  return cfg;
}

export async function main() {
  const cfg = durableKonfiguration();
  const pd = cfg.pi_durable;
  spracheSetzen(pd.sprache);
  const bindung = bindungPruefen(pd);
  if (bindung.fehler) {
    console.error(`[fle-durable] refused to start: ${bindung.fehler}`);
    process.exit(2);
  }
  for (const name of ['FYOS_RUNNER_TOKEN', 'FYOS_HAUSMODELL_KEY', 'FYOS_HUB_AGENT_TOKEN', 'FYOS_MODELL_SCHLUESSEL']) delete process.env[name];

  const runner = new Runner(cfg);
  await runner.start();
  const ingress = new Ingress({ cfg, runner, hub: null, spielmodus: runner.spielmodusEinlass, tor: null, ruhe: runner.ruhe });
  const einreihen = (e) => ingress.einreihen(e);
  const quellen = await loadPort('sources', {
    cfg,
    ctx: { cfg, hub: null, harness: runner.harness, enqueue: einreihen, runner, owner: ownerName(cfg) },
    known: builtinSources,
    defaults: DURABLE_DEFAULT_SOURCES,
  });
  ingress.beiZug = async (e) => {
    for (const q of quellen) await q.variant.onTurn?.(e);
  };
  await ingress.start();
  if (ingress.konfiguriert) for (const q of quellen) q.variant.start();

  const server = erstelleServer({ runner, cfg, ingress });
  await new Promise((fertig, scheitern) => {
    server.once('error', scheitern);
    server.listen(pd.port, pd.host, () => {
      server.off('error', scheitern);
      fertig();
    });
  });

  const sicht = oeffentlicheSicht(cfg);
  console.log(`[fle-durable] ready on http://${pd.host}:${pd.port}/ · storage: ${sicht.storage}`);
  console.log(`[fle-durable] model: ${sicht.model.default} at ${sicht.model.baseUrl}`);
  console.log(`[fle-durable] events: ${ingress.konfiguriert ? 'on' : 'off'} · sources: ${quellen.map((q) => q.name).join(', ') || 'none'}`);

  let schliesst = false;
  async function schliessen(signal) {
    if (schliesst) return;
    schliesst = true;
    console.log(`[fle-durable] ${signal}: closing`);
    setTimeout(() => process.exit(0), 5000).unref();
    await Promise.allSettled(quellen.map((q) => q.variant.stop()));
    await ingress.stop().catch(() => {});
    await new Promise((fertig) => {
      server.close(() => fertig());
      server.closeIdleConnections?.();
      setTimeout(() => server.closeAllConnections?.(), 1000).unref?.();
    });
    await runner.close().catch(() => {});
    process.exit(0);
  }
  process.on('SIGINT', () => void schliessen('SIGINT'));
  process.on('SIGTERM', () => void schliessen('SIGTERM'));
  runner.harness.closed.then((ende) => {
    if (ende.reason === 'failed') {
      console.error('[fle-durable] harness failed.', ende.error);
      process.exit(1);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((fehler) => {
    console.error(`[fle-durable] start failed: ${fehler?.stack ?? fehler}`);
    process.exit(1);
  });
}

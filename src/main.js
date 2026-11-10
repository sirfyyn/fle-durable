#!/usr/bin/env node
// The entry FLE Link starts: its FLE_DURABLE_* settings in the names the runner reads, then the runner without any host system.
import { main } from './durable.js';

const NAMES = {
  FLE_DURABLE_TOKEN: 'FYOS_RUNNER_TOKEN',
  FLE_DURABLE_PORT: 'FYOS_RUNNER_PORT',
  FLE_DURABLE_HOST: 'FYOS_RUNNER_HOST',
  FLE_DURABLE_CONFIG: 'FYOS_RUNNER_CONFIG',
  FLE_DURABLE_MODEL_URL: 'FYOS_MODELL_BASIS_URL',
  FLE_DURABLE_MODEL_KEY: 'FYOS_MODELL_SCHLUESSEL',
  FLE_DURABLE_MODEL: 'FYOS_MODELL_NAME',
  FLE_DURABLE_WORKSPACE: 'FYOS_RUNNER_WORKSPACE',
  FLE_DURABLE_BROWSER: 'FYOS_BROWSER_ENABLED',
  FLE_DURABLE_DESKTOP: 'FYOS_DESKTOP_ENABLED',
  FLE_DURABLE_DESKTOP_URL: 'FYOS_DESKTOP_URL',
  FLE_DURABLE_DESKTOP_TOKEN: 'FYOS_DESKTOP_TOKEN',
  FLE_DURABLE_DESKTOP_TARGET: 'FYOS_DESKTOP_ZIEL',
};
for (const [from, to] of Object.entries(NAMES)) {
  if (process.env[from] !== undefined) process.env[to] = process.env[from];
  delete process.env[from];
}
process.env.FYOS_RUNNER_LOKAL = '1';
process.env.FYOS_BROWSER_ENABLED ??= '1';
if (process.env.FLE_DURABLE_HOME) {
  process.env.FYOS_RUNNER_STORAGE ??= `${process.env.FLE_DURABLE_HOME}/durable.sqlite`;
  process.env.FYOS_BROWSER_PROFILE ??= `${process.env.FLE_DURABLE_HOME}/browser`;
  delete process.env.FLE_DURABLE_HOME;
}
if (process.env.FLE_DURABLE_EVENTS === '0') process.env.FYOS_RUNNER_PROAKTIV = '0';
delete process.env.FLE_DURABLE_EVENTS;
// the MCP hub from FLE Link's Settings: the runner uses the hub's REST rail on the same host, with the same headers
if (process.env.FLE_DURABLE_HUB_URL) {
  process.env.FYOS_HUB_URL = process.env.FLE_DURABLE_HUB_URL.replace(/\/+$/, '').replace(/\/mcp$/, '');
  if (process.env.FLE_DURABLE_HUB_HEADERS) process.env.FYOS_HUB_KOEPFE = process.env.FLE_DURABLE_HUB_HEADERS;
}
delete process.env.FLE_DURABLE_HUB_URL;
delete process.env.FLE_DURABLE_HUB_HEADERS;

main().catch((e) => {
  console.error(`[fle-durable] start failed: ${e?.stack ?? e}`);
  process.exit(1);
});

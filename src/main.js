#!/usr/bin/env node
/**
 * main.js — the command line.
 *
 *   fle-durable [--config file]          start the agent (see README for the environment)
 *   fle-durable check-source ./my.js     check a source module of your own against the contract
 *   fle-durable --version
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, publicView, startAgent } from './index.js';
import { checkSource } from './ports/conformance.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const argv = process.argv.slice(2);

async function checkSourceCommand(file) {
  const mod = await import(pathToFileURL(resolve(file)).href);
  const create = mod.create ?? mod.default;
  if (typeof create !== 'function') throw new Error(`${file}: exports neither create() nor a default function`);
  const problems = await checkSource(create, { cfg: loadConfig({}), options: {} });
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(problems.length ? `${file}: ${problems.length} problem(s)` : `${file}: conforms to the sources contract`);
  return problems.length ? 1 : 0;
}

async function main() {
  if (argv.includes('--version') || argv.includes('-v')) return console.log(pkg.version);
  if (argv[0] === 'check-source') process.exit(await checkSourceCommand(argv[1] ?? ''));
  const cfg = loadConfig();
  if (!cfg.token) {
    console.error('fle-durable: FLE_DURABLE_TOKEN is missing. Make one with:  openssl rand -hex 32');
    process.exit(2);
  }
  // the token and the model key are in the config now; commands of the agent must not inherit them
  for (const k of ['FLE_DURABLE_TOKEN', 'FLE_DURABLE_MODEL_KEY']) delete process.env[k];
  const agent = await startAgent(cfg);
  const v = publicView(cfg);
  console.log(`[fle-durable] ${pkg.version} ready on ${agent.url}`);
  console.log(`[fle-durable] model ${v.model.id} at ${v.model.baseUrl} (${v.model.contextWindow} tokens) · storage ${v.storage}`);
  console.log(`[fle-durable] events ${v.events ? 'on' : 'off'} · sources ${agent.sources.map((s) => s.name).join(', ') || 'none'} · zone ${v.zone}`);
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[fle-durable] ${signal}: closing`);
    setTimeout(() => process.exit(0), 5000).unref();
    await agent.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));
  agent.runner.harness.closed?.then((end) => {
    if (end?.reason === 'failed') {
      console.error('[fle-durable] the harness failed', end.error);
      process.exit(1);
    }
  });
}

main().catch((e) => {
  console.error(`[fle-durable] ${e?.message ?? e}`);
  process.exit(1);
});

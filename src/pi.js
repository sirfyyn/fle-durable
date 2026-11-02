/**
 * pi.js — the seam to pi-durable, pi-ai and chord (Earendil Works, MIT). No other file in src/ imports these packages
 * (test/seam.test.js checks it), so swapping, vendoring or forking them changes this file only.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import {
  Harness,
  ToolTask,
  UsageDoc,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  hook,
  section,
  watchEvents,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

/** The context every harness call runs under: a background service without a user session. */
export const CTX = BACKGROUND_CONTEXT;

export { Type, UsageDoc, defineDoc, defineExtension, defineTool, hook, section, ToolTask, createRegistry, CodingTools };

export const openStorage = (file) => openNodeSqliteStorage(file);

/**
 * Open the durable harness.
 * @param storage   from openStorage()
 * @param o         { models, registry, cwd, shell, env, compaction: {reserve, keep, background}, onReport }
 */
export function openHarness(storage, o) {
  return Harness.open(
    storage,
    {
      models: o.models,
      registry: o.registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? o.cwd, shellPath: o.shell || undefined, shellEnv: { ...process.env, ...(o.env ?? {}) } }),
      settings: {
        stream: { timeoutMs: o.streamTimeoutMs ?? 180_000 },
        retry: { maxRetries: o.retries ?? 2 },
        toolExecution: 'parallel',
        compaction: {
          enabled: true,
          reserveTokens: o.compaction.reserve,
          keepRecentTokens: o.compaction.keep,
          backgroundTokens: o.compaction.background,
        },
      },
      onReport: o.onReport,
    },
    CTX,
  );
}

/**
 * Models for one OpenAI-compatible server (llama-server, FLE, FLE Link's /v1, vLLM, …).
 * @param m { provider, name, baseUrl, apiKey, modelId, contextWindow, maxTokens }
 */
export function openaiModels(m, api = { stream, streamSimple }) {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: m.provider,
      name: m.name,
      baseUrl: m.baseUrl,
      auth: { apiKey: { name: `${m.name} key`, async resolve() { return { auth: { apiKey: m.apiKey || 'local' }, source: 'config' }; } } },
      models: [
        {
          id: m.modelId,
          name: `${m.name} (${m.modelId})`,
          api: 'openai-completions',
          provider: m.provider,
          baseUrl: m.baseUrl,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          reasoning: false,
        },
      ],
      api: { 'openai-completions': api },
    }),
  );
  return models;
}

/** Events of a conversation: `{ snapshot, start(listener), stop() }`; listener gets arrays of pi-durable events. */
export const watch = (harness, id) => watchEvents(harness, id, CTX);

/** The newest `n` entries of a conversation, oldest first, through reset and compaction markers. */
export async function history(conv, n = 400) {
  const newest = [];
  let cursor;
  do {
    const page = await conv.entries({ order: 'descending' }, Math.min(200, n - newest.length), cursor, CTX);
    newest.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined && newest.length < n);
  return newest.reverse();
}

/** Start a turn. `whenBusy`: 'followUp' (after the running turn) or 'steer' (into it). `requestId` makes it idempotent. */
export function submit(conv, { text, whenBusy = 'followUp', requestId, entry }) {
  return conv.submit({ type: 'input', content: text, whenBusy, requestId, ...(entry ? { entry } : {}) }, CTX);
}

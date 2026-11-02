/**
 * index.js — FLE Durable as a library: start an agent in your own program.
 *
 *   import { loadConfig, startAgent } from 'fle-durable';
 *   const agent = await startAgent(loadConfig());      // listens, works from events
 *   await agent.enqueue({ id: 'build-42', text: 'Build 42 failed', source: 'ci' });
 *   await agent.close();
 */
import { bindingProblem, loadConfig, publicView } from './config.js';
import { loadPort } from './ports/load.js';
import { builtinSources } from './ports/sources.js';
import { EventQueue } from './queue.js';
import { Runner } from './runner.js';
import { createApiServer } from './server.js';

export { loadConfig, bindingProblem, publicView };
export { Runner } from './runner.js';
export { EventQueue, OWNER, BACKGROUND } from './queue.js';
export { AgendaStore } from './agenda.js';

/**
 * @param cfg          from loadConfig()
 * @param o.known      more source variants by name, next to the builtins (your own: { name: { create, builtin:false } })
 * @param o.api        replaces the model's stream functions (tests)
 * @param o.listen     false: no HTTP server
 */
export async function startAgent(cfg, { known = {}, api, listen = true, log = console } = {}) {
  const problem = bindingProblem(cfg);
  if (problem && listen) throw new Error(problem);
  const runner = await new Runner(cfg, { api, log }).start();
  const queue = new EventQueue({ runner });
  const sources = await loadPort('sources', {
    cfg,
    ctx: { cfg, harness: runner.harness, agenda: runner.agenda, enqueue: (e) => queue.enqueue(e), owner: cfg.owner, log },
    known: { ...builtinSources, ...known },
    defaults: ['agenda'],
  });
  queue.start();
  if (cfg.events.enabled) for (const s of sources) await s.variant.start();
  let server = null;
  if (listen) {
    server = createApiServer({ cfg, runner, queue, sources });
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(cfg.port, cfg.host, () => {
        server.off('error', fail);
        done();
      });
    });
  }
  let closed = false;
  return {
    cfg,
    runner,
    queue,
    sources,
    server,
    url: server ? `http://${cfg.host}:${server.address().port}/` : null,
    enqueue: (e) => queue.enqueue(e),
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(sources.map((s) => s.variant.stop()));
      await queue.stop();
      if (server) {
        await new Promise((done) => {
          server.close(() => done());
          server.closeIdleConnections?.();
          setTimeout(() => server.closeAllConnections?.(), 1000).unref?.();
        });
      }
      await runner.close();
    },
  };
}

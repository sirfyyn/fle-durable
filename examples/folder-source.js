/**
 * examples/folder-source.js — a source of your own: every text file dropped into a folder becomes one event.
 *
 *   { "ports": { "sources": ["builtin", { "use": "./examples/folder-source.js", "folder": "~/inbox", "every_s": 10 }] } }
 *
 * The file name is the event id, so a file that stays is not handed over twice; handled files move to <folder>/done.
 * Check it with:  fle-durable check-source ./examples/folder-source.js
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function create({ enqueue, options = {}, log = console }) {
  const folder = String(options.folder ?? join(homedir(), 'fle-inbox')).replace(/^~(?=\/)/, homedir());
  const done = join(folder, 'done');
  const everyMs = Math.max(2, Number(options.every_s ?? 10)) * 1000;
  let timer = null;
  let seen = 0;
  let error = null;

  async function round() {
    try {
      if (!existsSync(folder)) return;
      mkdirSync(done, { recursive: true });
      for (const name of readdirSync(folder)) {
        const file = join(folder, name);
        if (!/\.(txt|md)$/i.test(name) || !statSync(file).isFile()) continue;
        const text = readFileSync(file, 'utf8').trim();
        if (text) await enqueue({ id: `folder:${name}`, text: `File ${name}:\n\n${text.slice(0, 8000)}`, source: 'folder', ref: name });
        renameSync(file, join(done, name));
        seen += 1;
      }
      error = null;
    } catch (e) {
      error = String(e?.message ?? e);
      log.error?.(`[folder-source] ${error}`);
    }
  }

  return {
    start() {
      const loop = async () => {
        await round();
        timer = setTimeout(loop, everyMs);
        timer.unref?.();
      };
      void loop();
    },
    stop() {
      clearTimeout(timer);
    },
    state: () => ({ folder, seen, error }),
  };
}

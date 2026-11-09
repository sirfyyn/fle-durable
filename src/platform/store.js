/**
 * platform/store.js — the SQLite file of the runner's own platform (bus, tickets, calendar, bridges).
 *
 * The conversations stay in the pi-durable file. The platform has real tables in a second file next to it, because tickets
 * and events need queries and history that a single JSON document cannot carry. The two files never share a transaction;
 * every hand-over between them is idempotent by id (see platform/bus.js).
 *
 * Plain node:sqlite, no dependency. Each module brings its own migrations, applied once and in order.
 */
import { mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Where the platform file lives: `platform.file`, otherwise next to the conversations and named after them (one per runner). */
export function platformFile(cfg) {
  const own = cfg?.platform?.file;
  if (own) return own;
  const storage = cfg?.pi_durable?.storage;
  if (!storage || storage === ':memory:') return ':memory:';
  return join(dirname(storage), `${basename(storage, extname(storage))}.platform.sqlite`);
}

export class PlatformStore {
  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied INTEGER NOT NULL)');
  }

  /** Apply each named statement batch once. Names are stable forever: `bus.1`, `tickets.1`, … */
  migrate(steps) {
    const known = this.db.prepare('SELECT 1 FROM migrations WHERE name = ?');
    const mark = this.db.prepare('INSERT INTO migrations (name, applied) VALUES (?, ?)');
    for (const [name, sql] of Object.entries(steps)) {
      if (known.get(name)) continue;
      this.transaction(() => {
        this.db.exec(sql);
        mark.run(name, Date.now());
      });
    }
  }

  /** Run `fn` in one transaction. Nested calls join the outer one. */
  transaction(fn) {
    if (this._inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this._inTransaction = true;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (fehler) {
      this.db.exec('ROLLBACK');
      throw fehler;
    } finally {
      this._inTransaction = false;
    }
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}

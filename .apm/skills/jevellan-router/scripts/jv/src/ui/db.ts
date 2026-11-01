// The viewer's own connection to the store: read only, by construction.
//
// - It never goes through Store.open: that connection is read-write and may take BEGIN IMMEDIATE to create the
//   schema. This one is `new DatabaseSync(file, { readOnly: true })`, so a write fails in SQLite itself, and a
//   missing file is never created (the viewer reports "no store yet" and opens it when it appears).
// - The schema version must be the runtime's (SCHEMA_VERSION); another version is refused, as every jv command does.
// - dataVersion() is SQLite's PRAGMA data_version: it changes when another connection committed, which is how the
//   live stream knows something changed without reading any table.

import { existsSync, statSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { JvError, refused } from '../errors.js';
import { paths } from '../paths.js';
import { SCHEMA_VERSION } from '../store.js';

/** Why the store cannot be read right now (no file yet, another schema version, a broken file). */
export class StoreUnavailable extends JvError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'StoreUnavailable';
  }
}

export class ReadOnlyStore {
  readonly file: string;
  private db: DatabaseSync | undefined;
  private inode: number | undefined;
  private readonly statements = new Map<string, StatementSync>();

  constructor(file: string = paths.store) {
    this.file = file;
  }

  /** The open connection, opening (and checking the schema version) when needed. */
  private connection(): DatabaseSync {
    if (this.db) return this.db;
    if (!existsSync(this.file)) throw new StoreUnavailable(`no store yet at ${this.file}`);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.file, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 5000');
    } catch (error) {
      throw new StoreUnavailable(`cannot open ${this.file}: ${(error as Error).message}`);
    }
    let version: unknown;
    try {
      version = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: unknown } | undefined)?.value;
    } catch {
      version = undefined;
    }
    if (version !== SCHEMA_VERSION) {
      db.close();
      throw new StoreUnavailable(
        version === undefined
          ? `${this.file} is not a jv store (no schema_version)`
          : `store schema version ${String(version)} does not match this runtime (${SCHEMA_VERSION}); run jv update`,
      );
    }
    this.db = db;
    try {
      this.inode = statSync(this.file).ino;
    } catch {
      this.inode = undefined;
    }
    return db;
  }

  /** Throws StoreUnavailable when the store cannot be read; used at start to refuse a wrong schema early. */
  check(): void {
    this.connection();
  }

  private stmt(sql: string): StatementSync {
    const db = this.connection();
    let s = this.statements.get(sql);
    if (!s) {
      s = db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql)
      .all(...params)
      .map((r) => ({ ...(r as object) }) as T);
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    const row = this.stmt(sql).get(...params);
    return row === undefined ? undefined : ({ ...(row as object) } as T);
  }

  /**
   * A token that changes whenever another connection committed to the store (PRAGMA data_version), or the store
   * appeared, disappeared or was replaced. Never throws.
   */
  dataVersion(): string {
    try {
      if (this.db && this.inode !== undefined) {
        let ino: number | undefined;
        try {
          ino = statSync(this.file).ino;
        } catch {
          ino = undefined;
        }
        if (ino !== this.inode) this.reset();
      }
      const row = this.stmt('PRAGMA data_version').get() as { data_version?: number } | undefined;
      return `${this.inode ?? 0}:${row?.data_version ?? 0}`;
    } catch (error) {
      return `unavailable:${(error as Error).message}`;
    }
  }

  /** Drops the connection; the next read opens the file again. */
  reset(): void {
    this.statements.clear();
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = undefined;
    this.inode = undefined;
  }

  close(): void {
    this.reset();
  }
}

/** Refuses a store of another schema at start (a missing store is fine: the viewer waits for it). */
export function checkReadable(store: ReadOnlyStore): void {
  try {
    store.check();
  } catch (error) {
    if (error instanceof StoreUnavailable && !existsSync(store.file)) return;
    if (error instanceof JvError) throw refused(error.message);
    throw error;
  }
}

// Opening the local library the pointer names — the §5.3 handshake.
//
// The pointer is a hint, not an authority: this module opens the file it names
// and then *checks* it, and every failure is a refusal to write rather than a
// fall-through to the account path.
//
// What is deliberately absent: any path that could create a database.
// Creation, WAL and migration belong to the desktop app alone (§5.3, §4.3), so
// a missing file is a hard error and a file that is not in WAL is a corrupt
// installation the CLI reports rather than "fixes".

import { existsSync } from 'node:fs';
import { SQLITE_MIGRATIONS } from '../core/index.js';
import { readPointer, type LocalLibraryPointer } from './pointer.js';
import {
  assertSqliteFloor,
  loadSqlite,
  sqliteVersionOf,
  LocalModeError,
  type SqliteDatabase,
} from './runtime.js';

/**
 * The busy timeout, in ms, matching the sqlx default the app runs with (§4.3,
 * measured). sqlx sets `foreign_keys=ON` and `busy_timeout=5s` for the app's
 * connections; a separate driver gets neither for free, so both are set
 * explicitly here — the CLI is the *other* process in every cross-process race
 * WAL has to absorb.
 */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * The migration that first creates the four tables `planSaveNote` writes
 * (`notes`, `folders`, `tags`, `note_tags`). A library below it cannot hold a
 * jot at all.
 *
 * Accepting `MIN..MAX` leans on an invariant worth naming: the applier's
 * INSERTs name every column of the **newest** vendored schema, so no shipped
 * migration may add a column to those four tables without raising this floor
 * alongside it — an older-but-accepted library would refuse every jot with a
 * no-such-column error. Migration 2 added tables only, so the range is safe
 * today.
 */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

/** The newest migration this CLI's vendored DDL knows about. */
export const MAX_SUPPORTED_SCHEMA_VERSION = SQLITE_MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

export interface LocalLibrary {
  readonly db: SqliteDatabase;
  /** The pointer that named this file, as read from disk. */
  readonly pointer: LocalLibraryPointer;
  readonly path: string;
  /**
   * `meta.workspace_uuid` — the identity every row local mode writes carries as
   * its `user_id` (§5.1; the desktop's local mode does the same, WP6 B3).
   */
  readonly workspaceId: string;
  /** `MAX(version)` of `_sqlx_migrations`, the library's own schema version. */
  readonly schemaVersion: number;
  close(): void;
}

function scalar(db: SqliteDatabase, sql: string): unknown {
  const row = db.prepare(sql).get();
  if (row === undefined) return undefined;
  return Object.values(row)[0];
}

/**
 * Runs the §5.3 handshake and hands back an open, write-ready library.
 *
 * @param dir the config root (`configDir()`), honoring `JOTNOW_CONFIG_DIR`
 *   exactly as the key file does — which is what makes the two-process test
 *   harness possible without touching a developer's real library (§5.1).
 *   The desktop app does NOT honor it: `pointer.rs` writes to the real
 *   `~/.jotnow/` unconditionally, so overriding the dir hides the app's
 *   pointer and local mode reads as "not set up" — deliberate for tests,
 *   documented in the README for everyone else.
 */
export function openLocalLibrary(dir: string): LocalLibrary {
  const pointer = readPointer(dir);

  // A dangling `db_path` is routine — an uninstalled channel, an MSIX repair,
  // a cleared ~/.jotnow/local/ — and §5.3 makes it a hard error precisely
  // because the alternative (treating it as "no local library") would ship a
  // local-first user's jots to a server they abandoned.
  if (!existsSync(pointer.db_path)) {
    throw new LocalModeError(
      `the jotnow local library named by the pointer is missing: ${pointer.db_path}. ` +
        `Launch the desktop app to recreate it — nothing was written, and nothing was ` +
        `sent to the server.`,
    );
  }

  const DatabaseSync = loadSqlite();
  let db: SqliteDatabase;
  try {
    // Opened read-write. `existsSync` above is what keeps this from creating a
    // library: node:sqlite creates on open, and a CLI-minted database is an
    // orphan the app never opens (§5.3). The window between the check and the
    // open belongs to the app, which only ever creates this file.
    db = new DatabaseSync(pointer.db_path, { enableForeignKeyConstraints: true });
  } catch (error) {
    throw new LocalModeError(
      `could not open the jotnow local library at ${pointer.db_path}: ${String(error)}. ` +
        `Nothing was written, and nothing was sent to the server.`,
    );
  }

  try {
    assertSqliteFloor(sqliteVersionOf(db));

    // Explicit, both of them: sqlx's defaults cover the app's connections only
    // (§4.3). `foreign_keys` is passed as an option *and* asserted, because the
    // option's default is a property of node:sqlite rather than of this code.
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

    const journalMode = String(scalar(db, 'PRAGMA journal_mode') ?? '').toLowerCase();
    if (journalMode !== 'wal') {
      // Never "fixed": only the app creates this file, and it sets WAL once at
      // creation (§4.3). A non-WAL library is a corrupt installation.
      throw new LocalModeError(
        `the jotnow local library at ${pointer.db_path} is not in WAL mode ` +
          `(journal_mode=${journalMode || 'unknown'}), which means it was not created by the ` +
          `desktop app. Nothing was written — reinstall the desktop app or remove that file ` +
          `and launch it again.`,
      );
    }

    const workspaceId = readWorkspaceUuid(db, pointer.db_path);
    if (workspaceId !== pointer.workspace_uuid) {
      throw new LocalModeError(
        `the jotnow pointer file and the library at ${pointer.db_path} disagree about which ` +
          `workspace it is (pointer ${pointer.workspace_uuid}, library ${workspaceId}). ` +
          `Launch the desktop app to republish the pointer; nothing was written.`,
      );
    }

    const schemaVersion = readSchemaVersion(db, pointer.db_path);
    if (schemaVersion !== pointer.schema_version) {
      throw new LocalModeError(
        `the jotnow pointer file and the library at ${pointer.db_path} disagree about its ` +
          `schema version (pointer ${pointer.schema_version}, library ${schemaVersion}). ` +
          `Launch the desktop app to republish the pointer; nothing was written.`,
      );
    }
    if (schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION) {
      throw new LocalModeError(
        `the jotnow local library is newer than this CLI understands (library schema ` +
          `${schemaVersion}, this CLI ${MAX_SUPPORTED_SCHEMA_VERSION}). ` +
          `Update the CLI: npm i -g jotnow. Nothing was written.`,
      );
    }
    if (schemaVersion < MIN_SUPPORTED_SCHEMA_VERSION) {
      throw new LocalModeError(
        `the jotnow local library at ${pointer.db_path} has no schema applied ` +
          `(migration version ${schemaVersion}). Launch the desktop app to migrate it; ` +
          `nothing was written.`,
      );
    }

    return {
      db,
      pointer,
      path: pointer.db_path,
      workspaceId,
      schemaVersion,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    if (error instanceof LocalModeError) throw error;
    // The first statement that actually reads the file is the journal-mode
    // pragma, outside any per-step handler — so a truncated or non-SQLite
    // `library.db` lands here as a raw SqliteError, and it must leave in the
    // same voice as every other refusal on this path.
    throw new LocalModeError(
      `the jotnow local library at ${pointer.db_path} could not be read ` +
        `(${String(error)}). Launch the desktop app to recreate it; nothing was written.`,
    );
  }
}

/**
 * `meta` is a key/value table and `workspace_uuid` is the only key ever minted
 * into it (§5.1).
 */
function readWorkspaceUuid(db: SqliteDatabase, path: string): string {
  let value: unknown;
  try {
    value = db.prepare(`SELECT "value" FROM "meta" WHERE "key" = 'workspace_uuid'`).get()?.value;
  } catch (error) {
    throw new LocalModeError(
      `${path} does not look like a jotnow library (${String(error)}). Nothing was written.`,
    );
  }
  if (typeof value !== 'string' || value === '') {
    throw new LocalModeError(
      `${path} carries no workspace identity, so it is not a jotnow library the CLI may ` +
        `write to. Launch the desktop app; nothing was written.`,
    );
  }
  return value;
}

/**
 * `MAX(version)` of `_sqlx_migrations` — the migrator's own bookkeeping for the
 * file, which is what `Library::schema_version` reports and what the pointer
 * carries.
 *
 * **Not a `meta` row.** §5.3's prose says the CLI reads
 * `meta(workspace_uuid, schema_version)`; only the first half of that exists,
 * and PR A's annotation under §7 item 6 is the correction this implements.
 */
function readSchemaVersion(db: SqliteDatabase, path: string): number {
  let value: unknown;
  try {
    value = scalar(db, 'SELECT MAX(version) FROM "_sqlx_migrations"');
  } catch (error) {
    throw new LocalModeError(
      `${path} has no migration history, so it is not a jotnow library the CLI may write ` +
        `to (${String(error)}). Nothing was written.`,
    );
  }
  if (value === null || value === undefined) return 0;
  const version = Number(value);
  if (!Number.isFinite(version)) {
    throw new LocalModeError(
      `${path} reports an unreadable schema version. Launch the desktop app; nothing was written.`,
    );
  }
  return version;
}

// `jot` against the local library: the vendored planner, applied.
//
// The planning half is not written here on purpose — `planSaveNote`
// (`../core/save-note.ts`) is the single port of `mcp_save_note`, pinned to the
// RPC row-for-row by `supabase/tests/save-note-conformance.test.ts` (§6, §9).
// This module is the *applier* the plan needs, and it owes the plan exactly two
// properties the conformance suite depends on: the ops run in order, and they
// run all-or-nothing.

import { randomUUID } from 'node:crypto';
import {
  LOCAL_STORE_SQLITE_SCHEMA,
  planSaveNote,
  selectTagVocabulary,
  type ExistingFolder,
  type ExistingTag,
  type SaveNoteOp,
  type SaveNoteSource,
  type TagVocabularyLink,
} from '../core/index.js';
import type { SavedNote } from '../api.js';
import { normalizeTags } from '../tagging.js';
import type { LocalLibrary } from './library.js';
import type { SqliteDatabase } from './runtime.js';

export interface LocalSaveNoteInput {
  readonly title: string;
  readonly body: string;
  readonly tags?: string[];
  readonly folder?: string;
  readonly source?: SaveNoteSource;
  /** Prior tag spellings, same hint the API path passes to `normalizeTags`. */
  readonly vocabulary?: string[];
}

/**
 * Applies one planned op.
 *
 * Every column of the table is named and bound, because the planner emits
 * complete rows and "absent is not a state" in the batch contract. `ifExists:
 * 'ignore'` — which only the `note_tags` insert carries — becomes
 * `INSERT OR IGNORE`, the SQL's `on conflict do nothing`. Every other op must
 * fail on conflict: that is how the planner's no-update-path quirk is enforced.
 */
function applyOp(db: SqliteDatabase, op: SaveNoteOp): void {
  const columns = Object.keys(LOCAL_STORE_SQLITE_SCHEMA[op.table].columns);
  const ignore = 'ifExists' in op;
  const sql =
    `INSERT ${ignore ? 'OR IGNORE ' : ''}INTO "${op.table}" ` +
    `(${columns.map((column) => `"${column}"`).join(', ')}) ` +
    `VALUES (${columns.map(() => '?').join(', ')})`;
  const row = op.row as unknown as Record<string, unknown>;
  db.prepare(sql).run(...columns.map((column) => row[column] ?? null));
}

/**
 * One write transaction, **`BEGIN IMMEDIATE`** — the same choice the desktop
 * applier makes and for the same reason
 * (`apps/desktop/src-tauri/src/store/apply.rs`, §4.3): `saveNoteLocally` reads before it writes (the folder and tag lookups
 * run inside this transaction), and in WAL a deferred read-then-write
 * transaction that loses a cross-process race gets `SQLITE_BUSY_SNAPSHOT`
 * **immediately**, which `busy_timeout` does not cover. Taking the write lock
 * up front turns the app-writing-at-the-same-moment case into a wait instead
 * of a failure. The CLI is the second process in every one of those races.
 *
 * The `ROLLBACK` is guarded: `SQLITE_FULL`/`SQLITE_IOERR`/`SQLITE_NOMEM` roll
 * the transaction back on their own, and a bare `ROLLBACK` then throws
 * "no transaction is active" — masking the error the user needed to read, on
 * the one path whose messages are contracted to be the whole explanation.
 */
function inWriteTransaction<T>(db: SqliteDatabase, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // already rolled back by SQLite itself
    }
    throw error;
  }
}

/**
 * Runs the ops as one transaction.
 *
 * All-or-nothing is not a nicety: `mcp_save_note` rolls back the folder and
 * tags it had already created when the note insert conflicts, and the
 * conformance suite — which runs *this* function — asserts the local side
 * leaves the library exactly as it found it.
 */
export function applySaveNotePlan(db: SqliteDatabase, ops: readonly SaveNoteOp[]): void {
  inWriteTransaction(db, () => {
    for (const op of ops) applyOp(db, op);
  });
}

/**
 * Reads what the RPC's two lookups read, plans, applies, and returns the same
 * shape the API path returns — so the CLI and the MCP tool print one thing.
 *
 * The reads are scoped to the library's own workspace id, which is what local
 * mode writes into `user_id` (§5.1). A local library holds exactly one
 * workspace, so the predicate is belt-and-braces rather than a tenancy
 * boundary — but `selectTagVocabulary` counts whatever it is handed, and
 * scoping at the query is the habit that keeps that true.
 */
export function saveNoteLocally(library: LocalLibrary, input: LocalSaveNoteInput): SavedNote {
  const { db, workspaceId } = library;
  // Normalized through the same choke point the API path uses, so tag hygiene
  // cannot differ by mode.
  const tags = input.tags ? normalizeTags(input.tags, input.vocabulary) : [];

  // Read, plan and apply inside ONE write transaction. The reads are the
  // get-or-create lookups, and outside the transaction they are the §4.9
  // two-process race: this process and the app (or a second CLI) both read
  // "no folder named Work", both plan one, both insert — two folders, no
  // error. `BEGIN IMMEDIATE` serializes the whole read-plan-apply against
  // every other writer, so the second process reads the first one's folder.
  const plan = inWriteTransaction(db, () => {
    const folders = db
      .prepare(
        `SELECT "id", "name", "created_at", "deleted_at" FROM "folders" WHERE "user_id" = ?`,
      )
      .all(workspaceId) as unknown as ExistingFolder[];
    const existingTags = db
      .prepare(`SELECT "id", "name", "deleted_at" FROM "tags" WHERE "user_id" = ?`)
      .all(workspaceId) as unknown as ExistingTag[];

    const planned = planSaveNote(
      {
        userId: workspaceId,
        folders,
        tags: existingTags,
        now: new Date().toISOString(),
        newId: () => randomUUID(),
      },
      {
        id: randomUUID(),
        title: input.title,
        body: input.body,
        tags: input.tags ? tags : undefined,
        folder: input.folder ?? null,
        source: input.source ?? 'mcp',
      },
    );
    for (const op of planned.ops) applyOp(db, op);
    return planned;
  });

  return {
    id: plan.note.id,
    title: plan.note.title,
    created_at: plan.note.created_at,
    tags,
    existingTags: readTagVocabulary(db, workspaceId),
  };
}

/**
 * The RPC's `tag_vocab` projection, read **after** the apply — the SQL builds
 * it in its return expression, so a tag this call created is in it, with its
 * new link counted.
 */
function readTagVocabulary(db: SqliteDatabase, workspaceId: string): string[] {
  const tags = db
    .prepare(`SELECT "id", "name", "deleted_at" FROM "tags" WHERE "user_id" = ?`)
    .all(workspaceId) as unknown as ExistingTag[];
  const noteTags = db
    .prepare(`SELECT "tag_id", "deleted_at" FROM "note_tags" WHERE "user_id" = ?`)
    .all(workspaceId) as unknown as TagVocabularyLink[];
  return selectTagVocabulary({ tags, noteTags });
}

// The CLI's half of the pointer file (plans/desktop-app.md §5.3; the app's
// half is `apps/desktop/src-tauri/src/pointer.rs`, PR A).
//
// The app writes `~/.jotnow/local-library.json` on every launch, naming the
// database it actually opened plus that library's identity and schema version.
// This module only *reads and parses* it — the handshake that decides whether
// the named file may be written to lives in `library.ts`, because the pointer
// is a hint and never an authority.
//
// Two rules from §5.3 that are easy to lose and are enforced here:
//
//   * a **missing** pointer means "run the desktop app once", not "there is no
//     local library, use the server";
//   * a pointer that is present but unreadable is a hard error. Neither case
//     ever falls through to the account path — that fall-through is the §5.4
//     privacy violation the whole arrangement exists to prevent.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalModeError } from './runtime.js';

/** Sits beside `config.json` under the root `configDir()` resolves (§5.1). */
export const POINTER_FILE = 'local-library.json';

/**
 * The pointer *format's* version — not the library's schema version, which
 * moves independently and is the handshake's business. Bumped only for a
 * change a reader that predates it cannot survive, exactly the rule §5.4
 * states for `config.json`.
 */
export const POINTER_VERSION = 1;

/**
 * The four keys, `snake_case` — deliberately, since they are the handshake's
 * comparison keys spelled the way the database spells them (pointer.rs).
 */
export interface LocalLibraryPointer {
  readonly version: number;
  readonly db_path: string;
  readonly workspace_uuid: string;
  readonly schema_version: number;
}

export function pointerPath(dir: string): string {
  return join(dir, POINTER_FILE);
}

/**
 * Whether a local library is *on offer* on this machine — the §5.4 precedence
 * question, and nothing more.
 *
 * Deliberately the file's presence rather than its validity: a pointer whose
 * `db_path` dangles still means "this user chose local mode", so it must make
 * the machine ambiguous (row 4) rather than resolve silently to the account.
 */
export function pointerExists(dir: string): boolean {
  return existsSync(pointerPath(dir));
}

export function readPointer(dir: string): LocalLibraryPointer {
  const file = pointerPath(dir);
  if (!existsSync(file)) {
    throw new LocalModeError(
      `local capture requires the desktop app — run it once to create your local library ` +
        `(no pointer file at ${file}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new LocalModeError(
      `${file} is not valid JSON. Launch the jotnow desktop app to rewrite it; ` +
        `nothing was written.`,
    );
  }

  const record = parsed as Partial<Record<keyof LocalLibraryPointer, unknown>>;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof record.version !== 'number' ||
    typeof record.db_path !== 'string' ||
    record.db_path === '' ||
    typeof record.workspace_uuid !== 'string' ||
    record.workspace_uuid === '' ||
    typeof record.schema_version !== 'number'
  ) {
    throw new LocalModeError(
      `${file} has an unexpected shape. Launch the jotnow desktop app to rewrite it; ` +
        `nothing was written.`,
    );
  }

  if (record.version > POINTER_VERSION) {
    throw new LocalModeError(
      `${file} was written by a newer jotnow desktop app (pointer version ` +
        `${record.version}; this CLI understands ${POINTER_VERSION}). ` +
        `Update the CLI: npm i -g jotnow.`,
    );
  }

  return {
    version: record.version,
    db_path: record.db_path,
    workspace_uuid: record.workspace_uuid,
    schema_version: record.schema_version,
  };
}

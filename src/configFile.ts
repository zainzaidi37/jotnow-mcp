import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Stores the API key once per machine so terminal use and MCP configs don't
// need JOTNOW_API_KEY in every env block (see resolveConfig in config.ts).

const CONFIG_VERSION = 1;

/** The two things `jotnow` can be pointed at (plans/desktop-app.md §5.4). */
export type JotnowMode = 'local' | 'account';

export const JOTNOW_MODES: readonly JotnowMode[] = ['local', 'account'];

/**
 * `mode` is **optional and `version` stays 1**, deliberately (§5.4).
 *
 * The loader below throws on any `version !== CONFIG_VERSION`, so a v2 file
 * written by a new CLI would make every *older installed* CLI fail on every
 * invocation — and users install this with `npx`, so versions drift freely. An
 * unknown key, by contrast, is simply ignored by an old reader. Only bump the
 * version for a change an old reader genuinely cannot survive.
 *
 * `apiKey` is optional for the same family of reasons in the other direction:
 * `jotnow use local` must be recordable on a machine that has no key at all.
 * The one cost, stated because it is the mirror image of the rule above: a
 * config written by `jotnow use local` before any `jotnow key` has no `apiKey`,
 * and a CLI older than this one rejects that file as "unexpected shape". A
 * machine that has only ever chosen local mode has nothing for an older CLI to
 * do, and the alternative — refusing to record the mode without a key — leaves
 * `JOTNOW_MODE` as the only way to run local mode.
 */
interface StoredConfig {
  version: 1;
  apiKey?: string;
  mode?: JotnowMode;
}

// os.homedir() rather than XDG_CONFIG_HOME/%APPDATA%: an MCP host launches
// this process with its own, often-stripped env (no XDG/APPDATA vars), but
// os.homedir() is resolved from the OS user record, not env — it names the
// same directory whether jotnow is run from a shell or an MCP host.
export function configDir(env: Record<string, string | undefined> = process.env): string {
  return env.JOTNOW_CONFIG_DIR?.trim() || join(homedir(), '.jotnow');
}

export function configFilePath(dir: string): string {
  return join(dir, 'config.json');
}

/**
 * Writes the config file, preserving whatever `loadStoredConfig` reads back.
 *
 * Read-modify-write rather than overwrite, because the file now carries two
 * independent settings: `jotnow key` must not erase a stored mode, and
 * `jotnow use` must not erase the key.
 */
function writeStoredConfig(dir: string, patch: Partial<Omit<StoredConfig, 'version'>>): void {
  // A corrupt existing file is recreated, not rethrown: `loadStoredKey`'s
  // error text says "Run `jotnow key` to recreate it", and before `mode`
  // existed the save was an unconditional overwrite — so the write commands
  // are the documented repair path and must never be blocked by the state
  // they exist to repair. What a garbage file loses is only what it already
  // lost: nothing in it was readable.
  let existing: Partial<Omit<StoredConfig, 'version'>> = {};
  if (existsSync(configFilePath(dir))) {
    try {
      existing = loadStoredConfig(dir);
    } catch {
      existing = {};
    }
  }
  const next: StoredConfig = { version: CONFIG_VERSION, ...existing, ...patch };

  mkdirSync(dir, { recursive: true });
  // mkdirSync's `mode` option and writeFileSync's creation mode are both
  // subject to the process umask, so don't rely on them — chmod explicitly
  // to guarantee the exact bits regardless of the caller's environment.
  chmodSync(dir, 0o700);

  const file = configFilePath(dir);
  const tmp = join(dir, `.config.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, '');
  chmodSync(tmp, 0o600); // lock down perms before the key is ever written into the file
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file); // rename replaces the destination in one step (atomic on POSIX; replaces on Windows too)
}

export function saveStoredKey(key: string, dir: string): void {
  writeStoredConfig(dir, { apiKey: key });
}

/** `jotnow use local|account` — the persisted rung of §5.4's precedence. */
export function saveStoredMode(mode: JotnowMode, dir: string): void {
  writeStoredConfig(dir, { mode });
}

/**
 * Loads the stored config, if any. Missing file → `{}` (first run).
 * Corrupt JSON or the wrong shape → throws, naming the file and pointing at
 * `jotnow key` to recreate it — callers must not swallow this into a
 * "no key found" state, since that would hide a real problem.
 */
export function loadStoredConfig(
  dir: string,
  stderr: { write: (chunk: string) => unknown } = process.stderr,
): { apiKey?: string; mode?: JotnowMode } {
  const file = configFilePath(dir);
  if (!existsSync(file)) return {};

  const raw = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON. Run \`jotnow key\` to recreate it.`);
  }
  const record = parsed as Partial<StoredConfig>;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    record.version !== CONFIG_VERSION ||
    // Both fields optional, but a file carrying neither is not a config this
    // package wrote — it is the "unexpected shape" case, and saying so is what
    // keeps a typo'd key field from reading as "no key stored".
    (record.apiKey === undefined && record.mode === undefined) ||
    (record.apiKey !== undefined && typeof record.apiKey !== 'string') ||
    (record.mode !== undefined && !JOTNOW_MODES.includes(record.mode))
  ) {
    throw new Error(`${file} has an unexpected shape. Run \`jotnow key\` to recreate it.`);
  }

  // Windows: skip perms handling entirely. The user profile directory is
  // already ACL'd to the current user by the OS — same posture gh and npm
  // take for their own config files.
  if (process.platform !== 'win32') {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) {
      chmodSync(file, 0o600);
      // stderr, never stdout: a bare `jotnow` invocation is an MCP stdio
      // server, and anything written to stdout corrupts JSON-RPC framing.
      stderr.write(`warning: tightened permissions on ${file} to 0600 (were 0${mode.toString(8)})\n`);
    }
  }

  return { apiKey: record.apiKey, mode: record.mode };
}

/** Loads the stored key, if any. Missing file, or a file with no key → undefined. */
export function loadStoredKey(
  dir: string,
  stderr: { write: (chunk: string) => unknown } = process.stderr,
): string | undefined {
  return loadStoredConfig(dir, stderr).apiKey;
}

/** Loads the stored mode, if one was ever chosen. */
export function loadStoredMode(
  dir: string,
  stderr: { write: (chunk: string) => unknown } = process.stderr,
): JotnowMode | undefined {
  return loadStoredConfig(dir, stderr).mode;
}

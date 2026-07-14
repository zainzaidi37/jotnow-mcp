import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Stores the API key once per machine so terminal use and MCP configs don't
// need JOTNOW_API_KEY in every env block (see resolveConfig in config.ts).

const CONFIG_VERSION = 1;

interface StoredConfig {
  version: 1;
  apiKey: string;
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

export function saveStoredKey(key: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  // mkdirSync's `mode` option and writeFileSync's creation mode are both
  // subject to the process umask, so don't rely on them — chmod explicitly
  // to guarantee the exact bits regardless of the caller's environment.
  chmodSync(dir, 0o700);

  const file = configFilePath(dir);
  const tmp = join(dir, `.config.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, '');
  chmodSync(tmp, 0o600); // lock down perms before the key is ever written into the file
  writeFileSync(tmp, `${JSON.stringify({ version: CONFIG_VERSION, apiKey: key } satisfies StoredConfig, null, 2)}\n`);
  renameSync(tmp, file); // rename replaces the destination in one step (atomic on POSIX; replaces on Windows too)
}

/**
 * Loads the stored key, if any. Missing file → undefined (first run).
 * Corrupt JSON or the wrong shape → throws, naming the file and pointing at
 * `jotnow key` to recreate it — callers must not swallow this into a
 * "no key found" state, since that would hide a real problem.
 */
export function loadStoredKey(
  dir: string,
  stderr: { write: (chunk: string) => unknown } = process.stderr,
): string | undefined {
  const file = configFilePath(dir);
  if (!existsSync(file)) return undefined;

  const raw = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON. Run \`jotnow key\` to recreate it.`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Partial<StoredConfig>).version !== CONFIG_VERSION ||
    typeof (parsed as Partial<StoredConfig>).apiKey !== 'string'
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

  return (parsed as StoredConfig).apiKey;
}

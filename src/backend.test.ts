import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesApi } from './api.js';
import { LocalBackend, resolveBackend, serveBackend } from './backend.js';
import { configFilePath, saveStoredKey, saveStoredMode } from './configFile.js';
import { FIXTURE_WORKSPACE, makeLibraryFixture } from './local/library-fixture.js';
import { buildServer } from './server.js';
import type { SqliteDatabaseConstructor } from './local/runtime.js';

/**
 * Mode resolution as the two surfaces actually meet it: the CLI commands and
 * the MCP tools, through one resolver (§5.4).
 */

const DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: SqliteDatabaseConstructor;
}).DatabaseSync;

const GOOD_KEY = `jn_live_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V'.slice(0, 43)}`;

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
};

function registeredTools(server: ReturnType<typeof buildServer>): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

function notesIn(dbPath: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT * FROM "notes"').all();
  } finally {
    db.close();
  }
}

describe('local mode backend', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jotnow-backend-'));
    ({ dbPath } = makeLibraryFixture(dir));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses the four reads by naming the desktop app (deliberately not implemented)', async () => {
    const backend = new LocalBackend(dir);
    for (const call of [
      () => backend.searchNotes(),
      () => backend.recallNotes(),
      () => backend.getNote(),
      () => backend.listRecentNotes(),
    ]) {
      await expect(call()).rejects.toThrow(/desktop app/);
    }
  });

  it('resolveBackend picks the library in local mode and NotesApi in account mode', () => {
    expect(resolveBackend({ JOTNOW_CONFIG_DIR: dir, JOTNOW_MODE: 'local' }).backend).toBeInstanceOf(
      LocalBackend,
    );
    const account = resolveBackend({
      JOTNOW_CONFIG_DIR: dir,
      JOTNOW_MODE: 'account',
      JOTNOW_API_KEY: GOOD_KEY,
    });
    expect(account.backend).toBeInstanceOf(NotesApi);
  });

  it('writes a jot into the library the pointer names, with no network call', async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('local mode must not touch the network');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const saved = await new LocalBackend(dir).saveNote({
        title: 'from the CLI',
        body: 'body',
        tags: ['Infra'],
        source: 'cli',
      });
      const notes = notesIn(dbPath);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ id: saved.id, title: 'from the CLI', user_id: FIXTURE_WORKSPACE, source: 'cli' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the MCP jot tool writes locally, and the read tools return the desktop-app error', async () => {
    const tools = registeredTools(buildServer(new LocalBackend(dir), '0.0.0-test', { repoTag: null }));
    const jotted = await tools.jot!.handler({ title: 'agent jot', body: 'b' }, {});
    expect(jotted.isError).toBeUndefined();
    expect(notesIn(dbPath)).toHaveLength(1);

    const found = await tools.find_jots!.handler({ query: 'anything' }, {});
    expect(found.isError).toBe(true);
    expect(found.content[0]!.text).toMatch(/desktop app/);
    // The class name never reaches the agent, only the sentence.
    expect(found.content[0]!.text).not.toContain('LocalModeError');
  });

  it('serve mode resolves per call: row 4 is a tool error, and `jotnow use` needs no restart', async () => {
    saveStoredKey(GOOD_KEY, dir);
    // Built while the machine is ambiguous — the server itself must come up,
    // because a refusal that prevents startup never shows anyone its message.
    const tools = registeredTools(
      buildServer(serveBackend({ JOTNOW_CONFIG_DIR: dir }), '0.0.0-test', { repoTag: null }),
    );

    const refused = await tools.jot!.handler({ title: 'ambiguous', body: 'b' }, {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('jotnow use account');
    expect(notesIn(dbPath)).toHaveLength(0);

    saveStoredMode('local', dir);
    const jotted = await tools.jot!.handler({ title: 'after use local', body: 'b' }, {});
    expect(jotted.isError).toBeUndefined();
    expect(notesIn(dbPath)).toHaveLength(1);
  });

  it('a mid-session target switch drops the cached vocabulary hint — account spellings must not steer local tags', async () => {
    const fakeApi = {
      saveNote: async () => ({
        id: 'acct-1',
        title: 'account jot',
        created_at: '2026-08-06T00:00:00.000Z',
        tags: [],
        existingTags: ['Account-Spelling'],
      }),
    } as unknown as NotesApi;
    saveStoredKey(GOOD_KEY, dir);
    saveStoredMode('account', dir);
    const backend = serveBackend({ JOTNOW_CONFIG_DIR: dir }, () => fakeApi);
    await backend.saveNote({ title: 'first, to the account', body: '' });

    saveStoredMode('local', dir);
    // The MCP server would pass the account jot's existingTags as vocabulary
    // here; with the hint honored, the local tag row would be the account's
    // spelling "Account-Spelling" instead of the plain normalization.
    await backend.saveNote({
      title: 'then local',
      body: '',
      tags: ['account spelling'],
      vocabulary: ['Account-Spelling'],
    });

    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare('SELECT "name" FROM "tags"').all()).toEqual([{ name: 'account-spelling' }]);
    } finally {
      db.close();
    }
  });
});

describe('the CLI, through main()', () => {
  let dir: string;
  let dbPath: string;
  let logs: string[];
  let errors: string[];
  let restoreEnv: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jotnow-cli-mode-'));
    ({ dbPath } = makeLibraryFixture(dir));
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
    const previous = { ...process.env };
    process.env.JOTNOW_CONFIG_DIR = dir;
    delete process.env.JOTNOW_API_KEY;
    delete process.env.JOTNOW_MODE;
    restoreEnv = () => {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
    };
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('`jotnow add` writes to the local library when it is the only option', async () => {
    const { main } = await import('./cli.js');
    await main(['add', 'a local jot', '--body', 'hello']);
    expect(process.exitCode).toBeUndefined();
    expect(notesIn(dbPath).map((note) => note.title)).toEqual(['a local jot']);
    expect(logs.join('\n')).toContain('Jotted "a local jot"');
  });

  it('`jotnow search` in local mode points at the desktop app instead of half-answering', async () => {
    const { main } = await import('./cli.js');
    await main(['search', 'kong']);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/search is not available in local mode/);
  });

  it('a stored key plus a local library and no mode refuses, naming `jotnow use account`', async () => {
    saveStoredKey(GOOD_KEY, dir);
    const fetchMock = vi.fn(() => {
      throw new Error('nothing may be sent to the server');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { main } = await import('./cli.js');
    try {
      await main(['add', 'ambiguous', '--body', 'x']);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('jotnow use account');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notesIn(dbPath)).toHaveLength(0);
  });

  it('`jotnow use local` records the choice and unblocks the ambiguous machine', async () => {
    saveStoredKey(GOOD_KEY, dir);
    const { main } = await import('./cli.js');
    await main(['use', 'local']);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8'))).toEqual({
      version: 1,
      apiKey: GOOD_KEY,
      mode: 'local',
    });

    await main(['add', 'after choosing', '--body', 'x']);
    expect(process.exitCode).toBeUndefined();
    expect(notesIn(dbPath).map((note) => note.title)).toEqual(['after choosing']);
  });

  it('`jotnow where` names the target library, its identity, and the rung that decided', async () => {
    const { main } = await import('./cli.js');
    await main(['where']);
    const output = logs.join('\n');
    expect(output).toContain('mode:   local');
    expect(output).toContain(dbPath);
    expect(output).toContain(FIXTURE_WORKSPACE);
    expect(output).toMatch(/no API key is stored/);
    expect(process.exitCode).toBeUndefined();
  });

  it('`jotnow where` explains an ambiguous machine rather than raising', async () => {
    saveStoredKey(GOOD_KEY, dir);
    const { main } = await import('./cli.js');
    await main(['where']);
    expect(logs.join('\n')).toContain('jotnow use account');
    expect(process.exitCode).toBe(1);
  });

  it('`jotnow where` reports a dangling library without pretending the server is the target', async () => {
    rmSync(join(dir, 'local'), { recursive: true, force: true });
    const { main } = await import('./cli.js');
    await main(['where']);
    const output = logs.join('\n');
    expect(output).toContain('target: unavailable');
    expect(output).toContain('nothing was sent to the server');
    expect(process.exitCode).toBe(1);
  });
});

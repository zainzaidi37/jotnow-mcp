import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './cli.js';
import { makeLibraryFixture } from './local/library-fixture.js';
import type { SqliteDatabaseConstructor } from './local/runtime.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: SqliteDatabaseConstructor;
};

describe('cli.add-contract', () => {
  let dir: string;
  let dbPath: string;
  let errors: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-add-contract-'));
    ({ dbPath } = makeLibraryFixture(dir));
    vi.stubEnv('KINJOT_CONFIG_DIR', dir);
    vi.stubEnv('KINJOT_MODE', 'local');
    errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function stdin(body: string) {
    const stream = Object.assign(Readable.from([Buffer.from(body)]), { isTTY: false });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stream as typeof process.stdin);
  }

  // These are the argv sent by capture.mjs and hook.mjs respectively. The
  // plugin suites test their senders; this harness exercises the real receiver.
  it.each([
    ['Claude Code', 'The real fix', 'claude,work'],
    ['Codex', 'The real fix', 'codex,work'],
    ['leading-dash title', '--the real fix', 'codex,work'],
  ])('accepts %s argv and the verbatim stdin body', async (_plugin, title, tags) => {
    const body = '# The **real** fix\n\n```sh\nprintf hello\n```\n';
    stdin(body);
    await main(['add', title, '--tags', tags, '--folder', 'Research']);
    expect(process.exitCode).toBeUndefined();
    const db = new DatabaseSync(dbPath);
    try {
      const notes = db.prepare('SELECT title, body, folder_id FROM notes').all();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ title, body });
      expect(db.prepare('SELECT name FROM folders WHERE id = ?').all(notes[0]!.folder_id)).toEqual([
        { name: 'Research' },
      ]);
      expect(
        db
          .prepare(
            'SELECT tags.name FROM tags JOIN note_tags ON tags.id = note_tags.tag_id ORDER BY tags.name',
          )
          .all(),
      ).toEqual(
        tags
          .split(',')
          .sort()
          .map((name) => ({ name })),
      );
    } finally {
      db.close();
    }
  });

  it.each([
    ['add', 'title', '--foler', 'Research'],
    ['add', '--foler', 'Research', 'title'],
    ['add', '--foler'],
  ])('refuses unknown flags before saving anything: %j', async (...argv) => {
    stdin('body');
    await main(argv);
    expect(process.exitCode).toBe(2);
    expect(errors.join('\n')).toContain('--foler');
    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare('SELECT id FROM notes').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('continues to accept an empty piped body', async () => {
    stdin('');
    await main(['add', 'empty body']);
    expect(process.exitCode).toBeUndefined();
    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare('SELECT body FROM notes').all()).toEqual([{ body: '' }]);
    } finally {
      db.close();
    }
  });

  it.each([
    ['12345678-1234-4234-8234-123456789abc', false],
    ['12345678-1234-8234-8234-123456789abc', true],
    ['ABCDEF12-1234-1234-8234-123456789ABC', false],
  ])('saves --id %s in the local library', async (id, flagFirst) => {
    const args = flagFirst ? ['add', '--id', id, 'title'] : ['add', 'title', '--id', id];
    await main([...args, '--body', 'body']);
    expect(process.exitCode).toBeUndefined();
    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare('SELECT id, body FROM notes').all()).toEqual([
        { id: id.toLowerCase(), body: 'body' },
      ]);
    } finally {
      db.close();
    }
  });

  it('accepts a flag-shaped title followed by --id', async () => {
    const id = '12345678-1234-8234-8234-123456789abc';
    await main(['add', '--odd title', '--id', id, '--body', 'body']);
    expect(process.exitCode).toBeUndefined();
    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare('SELECT id, title FROM notes').all()).toEqual([
        { id, title: '--odd title' },
      ]);
    } finally {
      db.close();
    }
  });

  it('does not treat --id with a missing value as a title', async () => {
    await main(['add', '--id', '--folder', 'X']);
    expect(process.exitCode).toBe(2);
    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare('SELECT id FROM notes').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('refuses malformed --id before opening or writing the local library', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    rmSync(dbPath);
    await main(['add', 'title', '--id', 'bad', '--body', 'body']);
    expect(process.exitCode).toBe(2);
    expect(errors.join('\n')).toContain('--id must be a UUID');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => new DatabaseSync(dbPath, { readOnly: true })).toThrow();
    vi.unstubAllGlobals();
  });

  it('refuses a flag that needs a value and an extra positional', async () => {
    await main(['add', 'title', '--body']);
    expect(process.exitCode).toBe(2);
    expect(errors.join('\n')).toContain('needs a value');
    process.exitCode = undefined;
    await main(['add', 'title', 'extra', '--body', 'body']);
    expect(process.exitCode).toBe(2);
  });
});

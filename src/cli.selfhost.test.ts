import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { configFilePath } from './configFile.js';
import { runInitSelfHost, runWhere, selfHostApiUrl } from './cli.js';

const GOOD_KEY = `kj_live_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V'.slice(0, 43)}`;
const REF = 'abcdefghijklmnopqrst';

function response(init: RequestInit): Response {
  const { action } = JSON.parse(String(init.body)) as { action: string };
  return new Response(JSON.stringify(action === 'key_info' ? { access: 'read' } : { notes: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function capture() {
  const writes: string[] = [];
  return { write: (chunk: string) => (writes.push(chunk), true), all: () => writes.join('') };
}

describe('selfHostApiUrl', () => {
  it('expands a bare Supabase project ref', () => {
    expect(selfHostApiUrl(REF)).toBe(`https://${REF}.supabase.co/functions/v1/mcp-api`);
  });

  it('appends the function path to an origin and preserves a full URL path', () => {
    expect(selfHostApiUrl('https://project.example')).toBe(
      'https://project.example/functions/v1/mcp-api',
    );
    expect(selfHostApiUrl('http://localhost:54321/custom/path?x=1')).toBe(
      'http://localhost:54321/custom/path?x=1',
    );
  });

  it('rejects non-http URLs and embedded credentials', () => {
    expect(() => selfHostApiUrl('file:///tmp/api')).toThrow(/http/);
    expect(() => selfHostApiUrl('https://user:secret@example.test')).toThrow(/credentials/);
  });
});

describe('runInitSelfHost', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-selfhost-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('reads project and hidden key, validates, then persists the pair', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init: RequestInit) =>
      response(init),
    );
    vi.stubGlobal('fetch', fetchMock);
    const stdout = capture();
    await runInitSelfHost({
      env: { KINJOT_CONFIG_DIR: dir },
      readProject: async () => REF,
      readHidden: async () => GOOD_KEY,
      stdout,
    });

    const apiUrl = `https://${REF}.supabase.co/functions/v1/mcp-api`;
    expect(fetchMock).toHaveBeenCalledWith(apiUrl, expect.any(Object));
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8'))).toEqual({
      version: 2,
      apiKey: GOOD_KEY,
      apiUrl,
    });
    expect(stdout.all()).toContain(GOOD_KEY);
    expect(stdout.all()).toContain(`"KINJOT_API_URL": "${apiUrl}"`);
    expect(stdout.all()).toContain('mcpServers');
    expect(stdout.all()).toContain(
      'API key access: Read only — can read notes; cannot create or edit.',
    );
    expect(stdout.all()).toContain(`claude mcp add kinjot -e KINJOT_API_KEY=${GOOD_KEY}`);
    expect(stdout.all()).toContain(`codex mcp add kinjot --env KINJOT_API_KEY=${GOOD_KEY}`);
  });

  it('accepts project and key in one ended piped chunk without losing the second line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init: RequestInit) => response(init)),
    );
    const input = new EventEmitter();
    const done = runInitSelfHost({
      env: { KINJOT_CONFIG_DIR: dir },
      input,
      isTTY: false,
      stdout: capture(),
    });
    input.emit('data', Buffer.from(`${REF}\n${GOOD_KEY}\n`));
    input.emit('end');
    await done;

    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).apiKey).toBe(GOOD_KEY);
  });

  it('accepts ended piped input without a final newline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init: RequestInit) => response(init)),
    );
    const input = new EventEmitter();
    const done = runInitSelfHost({
      env: { KINJOT_CONFIG_DIR: dir },
      input,
      isTTY: false,
      stdout: capture(),
    });
    input.emit('data', `${REF}\n${GOOD_KEY}`);
    input.emit('end');
    await done;
    expect(existsSync(configFilePath(dir))).toBe(true);
  });

  it('preserves URL punctuation from the visible TTY prompt and releases its listeners', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init: RequestInit) =>
      response(init),
    );
    vi.stubGlobal('fetch', fetchMock);
    const input = new EventEmitter();
    const url = 'http://127.0.0.1:54321/custom/path?owner=o-neil&mode=1';
    const done = runInitSelfHost({
      env: { KINJOT_CONFIG_DIR: dir },
      flags: new Map([['key', GOOD_KEY]]),
      input,
      isTTY: true,
      stdout: capture(),
    });
    input.emit('data', Buffer.from(`${url}\r`));
    await done;
    expect(fetchMock).toHaveBeenCalledWith(url, expect.any(Object));
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
  });

  it('handles a two-line TTY paste without echoing the key and pauses the stream on completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init: RequestInit) => response(init)),
    );
    const projectUrl = 'http://127.0.0.1:54321/functions/v1/mcp-api?mode=test';
    const input = new EventEmitter() as EventEmitter & {
      setRawMode: Mock<(mode: boolean) => void>;
      pause: Mock<() => unknown>;
      resume: Mock<() => unknown>;
    };
    input.setRawMode = vi.fn();
    input.pause = vi.fn();
    input.resume = vi.fn();
    const promptOutput = capture();
    const done = runInitSelfHost({
      env: { KINJOT_CONFIG_DIR: dir },
      input,
      output: promptOutput,
      isTTY: true,
      stdout: capture(),
    });
    input.emit('data', Buffer.from(`${projectUrl}\r\n${GOOD_KEY}\r\n`));
    await done;

    expect(promptOutput.all()).toContain(projectUrl);
    expect(promptOutput.all()).not.toContain(GOOD_KEY);
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.resume).toHaveBeenCalledOnce();
    expect(input.pause).toHaveBeenCalledOnce();
    expect(input.listenerCount('data')).toBe(0);
  });

  it('an explicit endpoint skips the project question and accepts a supplied key', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init: RequestInit) =>
      response(init),
    );
    vi.stubGlobal('fetch', fetchMock);
    const readProject = vi.fn(async () => REF);
    const apiUrl = 'https://chosen.example/functions/v1/mcp-api';
    await runInitSelfHost({
      env: { KINJOT_CONFIG_DIR: dir },
      flags: new Map([
        ['api-url', apiUrl],
        ['key', GOOD_KEY],
      ]),
      readProject,
      stdout: capture(),
    });
    expect(readProject).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(apiUrl, expect.any(Object));
  });

  it('requires a project instead of silently falling back to hosted', async () => {
    await expect(
      runInitSelfHost({
        env: { KINJOT_CONFIG_DIR: dir },
        readProject: async () => ' ',
        readHidden: async () => GOOD_KEY,
        stdout: capture(),
      }),
    ).rejects.toThrow(/project ref or URL is required/);
    expect(existsSync(configFilePath(dir))).toBe(false);
  });

  it('rejects unknown flags before reading input or calling the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const readProject = vi.fn(async () => REF);
    const readHidden = vi.fn(async () => GOOD_KEY);
    await expect(
      runInitSelfHost({
        env: { KINJOT_CONFIG_DIR: dir },
        flags: new Map([['typo', 'value']]),
        readProject,
        readHidden,
        stdout: capture(),
      }),
    ).rejects.toThrow('unknown flag --typo');
    expect(readProject).not.toHaveBeenCalled();
    expect(readHidden).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not persist the key or endpoint when validation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"invalid"}', { status: 401 })),
    );
    await expect(
      runInitSelfHost({
        env: { KINJOT_CONFIG_DIR: dir },
        readProject: async () => REF,
        readHidden: async () => GOOD_KEY,
        stdout: capture(),
      }),
    ).rejects.toThrow();
    expect(existsSync(configFilePath(dir))).toBe(false);
  });

  it('where reports the endpoint paired with the stored key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init: RequestInit) => response(init)),
    );
    const apiUrl = 'https://project.example/functions/v1/mcp-api';
    await runInitSelfHost({
      env: { KINJOT_CONFIG_DIR: dir },
      flags: new Map([
        ['api-url', apiUrl],
        ['key', GOOD_KEY],
      ]),
      stdout: capture(),
    });
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...values) => {
      lines.push(values.join(' '));
    });
    runWhere({ KINJOT_CONFIG_DIR: dir });
    log.mockRestore();
    expect(lines).toContain(`target: ${apiUrl}`);
  });
});

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configFilePath } from './configFile.js';

const GOOD_KEY = `jn_live_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V'.slice(0, 43)}`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function capture() {
  const lines: string[] = [];
  return { write: (s: string) => (lines.push(s), true), all: () => lines.join('') };
}

describe('runKey', () => {
  let dir: string;
  let prevConfigDir: string | undefined;
  let prevApiKey: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jotnow-key-'));
    prevConfigDir = process.env.JOTNOW_CONFIG_DIR;
    prevApiKey = process.env.JOTNOW_API_KEY;
    process.env.JOTNOW_CONFIG_DIR = dir;
    delete process.env.JOTNOW_API_KEY;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.JOTNOW_CONFIG_DIR;
    else process.env.JOTNOW_CONFIG_DIR = prevConfigDir;
    if (prevApiKey === undefined) delete process.env.JOTNOW_API_KEY;
    else process.env.JOTNOW_API_KEY = prevApiKey;
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('happy path: prompts, validates against the API, saves the key, prints success', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();

    await runKey({ readHidden: async () => GOOD_KEY, stdout, stderr, env: process.env });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(existsSync(configFilePath(dir))).toBe(true);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).apiKey).toBe(GOOD_KEY);
    expect(stdout.all()).toMatch(/ok ✔/);
    expect(stdout.all()).toContain('mcpServers');
    expect(stdout.all()).toContain('claude mcp add jotnow -- npx -y jotnow');
  });

  it('malformed key: errors before any API call, saves nothing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();

    await expect(
      runKey({ readHidden: async () => 'jn_live_not_a_real_key', stdout, stderr, env: process.env }),
    ).rejects.toThrow(/does not look like/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(configFilePath(dir))).toBe(false);
  });

  it('API rejects the key (401): error surfaces, nothing saved, no key material anywhere in output', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: 'invalid or revoked API key' }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();

    await expect(runKey({ readHidden: async () => GOOD_KEY, stdout, stderr, env: process.env })).rejects.toThrow(
      /revoked/,
    );

    expect(existsSync(configFilePath(dir))).toBe(false);
    const combined = stdout.all() + stderr.all();
    expect(combined).not.toContain(GOOD_KEY);
    expect(combined).not.toContain('jn_live_');
  });

  it('success output never contains the key value or the jn_live_ prefix', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();

    await runKey({ readHidden: async () => GOOD_KEY, stdout, stderr, env: process.env });

    const combined = stdout.all() + stderr.all();
    expect(combined).not.toContain(GOOD_KEY);
    expect(combined).not.toMatch(/jn_live_/);
  });

  it('warns on stderr when JOTNOW_API_KEY is already set, but still saves', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();
    const env = { ...process.env, JOTNOW_API_KEY: 'jn_live_some_other_existing_env_key_value_x' };

    await runKey({ readHidden: async () => GOOD_KEY, stdout, stderr, env });

    expect(existsSync(configFilePath(dir))).toBe(true);
    expect(stderr.all()).toMatch(/JOTNOW_API_KEY/);
    expect(stderr.all()).toMatch(/override/i);
  });

  it('piped stdin end-to-end: a non-TTY input stream saves the key without touching setRawMode', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();
    const input = new EventEmitter() as EventEmitter & { setRawMode: ReturnType<typeof vi.fn>; isTTY: boolean };
    input.setRawMode = vi.fn();
    input.isTTY = false;

    const done = runKey({ input, isTTY: false, stdout, stderr, env: process.env });
    input.emit('data', Buffer.from(`${GOOD_KEY}\n`));
    await done;

    expect(input.setRawMode).not.toHaveBeenCalled();
    expect(existsSync(configFilePath(dir))).toBe(true);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).apiKey).toBe(GOOD_KEY);
  });
});

describe('copy', () => {
  it('HELP mentions `jotnow key` and the global-install tip', async () => {
    const { HELP } = await import('./cli.js');
    expect(HELP).toContain('jotnow key');
    expect(HELP).toContain('npm i -g jotnow');
  });

  it('runInit output includes the `jotnow key` tip', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(args.join(' ')));
    const { main } = await import('./cli.js');
    try {
      await main(['init', '--key', GOOD_KEY]);
    } finally {
      logSpy.mockRestore();
      vi.unstubAllGlobals();
    }
    expect(logs.join('\n')).toMatch(/jotnow key/);
  });
});

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DEFAULT_API_URL } from './config.js';
import { configFilePath } from './configFile.js';

const GOOD_KEY = `kj_live_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V'.slice(0, 43)}`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function capture() {
  const lines: string[] = [];
  return { write: (s: string) => (lines.push(s), true), all: () => lines.join('') };
}

describe('runKey', () => {
  let dir: string;
  let prevConfigDir: string | undefined;
  let prevApiKey: string | undefined;
  let prevApiUrl: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-key-'));
    prevConfigDir = process.env.KINJOT_CONFIG_DIR;
    prevApiKey = process.env.KINJOT_API_KEY;
    prevApiUrl = process.env.KINJOT_API_URL;
    process.env.KINJOT_CONFIG_DIR = dir;
    delete process.env.KINJOT_API_KEY;
    delete process.env.KINJOT_API_URL;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.KINJOT_CONFIG_DIR;
    else process.env.KINJOT_CONFIG_DIR = prevConfigDir;
    if (prevApiKey === undefined) delete process.env.KINJOT_API_KEY;
    else process.env.KINJOT_API_KEY = prevApiKey;
    if (prevApiUrl === undefined) delete process.env.KINJOT_API_URL;
    else process.env.KINJOT_API_URL = prevApiUrl;
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('happy path: validates the pasted key in one request, saves it, and prints success', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();

    await runKey({ readHidden: async () => GOOD_KEY, stdout, stderr, env: process.env });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(DEFAULT_API_URL);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${GOOD_KEY}`);
    expect(existsSync(configFilePath(dir))).toBe(true);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).apiKey).toBe(GOOD_KEY);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).apiUrl).toBeUndefined();
    expect(stdout.all()).toMatch(/ok ✔/);
    expect(stdout.all()).toContain('mcpServers');
    expect(stdout.all()).toContain('claude mcp add kinjot -- npx -y kinjot');
    expect(stdout.all()).toContain('codex mcp add kinjot -- npx -y kinjot');
    // The one-line commands come first; the JSON is the fallback for other clients.
    const output = stdout.all();
    expect(output.indexOf('claude mcp add')).toBeLessThan(output.indexOf('codex mcp add'));
    expect(output.indexOf('codex mcp add')).toBeLessThan(output.indexOf('mcpServers'));
  });

  it('treats a legacy production URL as the default when saving a key', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    await runKey({
      readHidden: async () => GOOD_KEY,
      stdout,
      stderr: capture(),
      env: {
        ...process.env,
        KINJOT_API_URL: 'https://opzbxxrjiiktduivkdwm.supabase.co/functions/v1/mcp-api',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(DEFAULT_API_URL, expect.any(Object));
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).apiUrl).toBeUndefined();
    expect(stdout.all()).not.toContain('KINJOT_API_URL');
  });

  it('malformed key: errors before any API call, saves nothing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();

    await expect(
      runKey({
        readHidden: async () => 'kj_live_not_a_real_key',
        stdout,
        stderr,
        env: process.env,
      }),
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

    await expect(
      runKey({ readHidden: async () => GOOD_KEY, stdout, stderr, env: process.env }),
    ).rejects.toThrow(/revoked/);

    expect(existsSync(configFilePath(dir))).toBe(false);
    const combined = stdout.all() + stderr.all();
    expect(combined).not.toContain(GOOD_KEY);
    expect(combined).not.toContain('kj_live_');
  });

  it('success output never contains the key value or the kj_live_ prefix', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();

    await runKey({ readHidden: async () => GOOD_KEY, stdout, stderr, env: process.env });

    const combined = stdout.all() + stderr.all();
    expect(combined).not.toContain(GOOD_KEY);
    expect(combined).not.toMatch(/kj_live_/);
  });

  it('carries a custom endpoint into JSON and both client commands with shell-safe quoting', async () => {
    const apiUrl =
      "https://self-hosted.example/functions/v1/mcp-api?next=$(touch nope);owner=o'neil";
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();
    const env = { ...process.env, KINJOT_API_URL: apiUrl };

    await runKey({ readHidden: async () => GOOD_KEY, stdout, stderr, env });

    expect(fetchMock).toHaveBeenCalledWith(apiUrl, expect.any(Object));
    expect(stdout.all()).toContain(`"KINJOT_API_URL": ${JSON.stringify(apiUrl)}`);
    const quotedUrl = `'${apiUrl.replaceAll("'", `'"'"'`)}'`;
    expect(stdout.all()).toContain(
      `claude mcp add kinjot -e KINJOT_API_URL=${quotedUrl} -- npx -y kinjot`,
    );
    expect(stdout.all()).toContain(
      `codex mcp add kinjot --env KINJOT_API_URL=${quotedUrl} -- npx -y kinjot`,
    );
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).apiUrl).toBe(apiUrl);
    expect(stdout.all()).toMatch(/custom endpoint automatically/i);
  });

  it('--api-url overrides the environment for validation and every printed setup form', async () => {
    const apiUrl = "https://chosen.example/functions/v1/mcp-api?next=$(touch nope);owner=o'neil";
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();
    const env = {
      ...process.env,
      KINJOT_API_URL: 'https://ignored.example/functions/v1/mcp-api',
    };

    await runKey({
      readHidden: async () => GOOD_KEY,
      stdout,
      stderr,
      env,
      flags: new Map([['api-url', apiUrl]]),
    });

    expect(fetchMock).toHaveBeenCalledWith(apiUrl, expect.any(Object));
    expect(stdout.all()).toContain(`"KINJOT_API_URL": ${JSON.stringify(apiUrl)}`);
    const quotedUrl = `'${apiUrl.replaceAll("'", `'"'"'`)}'`;
    expect(stdout.all()).toContain(`claude mcp add kinjot -e KINJOT_API_URL=${quotedUrl}`);
    expect(stdout.all()).toContain(`codex mcp add kinjot --env KINJOT_API_URL=${quotedUrl}`);
    expect(stdout.all()).not.toContain('ignored.example');
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).apiUrl).toBe(apiUrl);
    expect(stdout.all()).toMatch(/custom endpoint automatically/i);
  });

  it('rejects an empty --api-url before validation or storage', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');

    await expect(
      runKey({
        readHidden: async () => GOOD_KEY,
        env: process.env,
        flags: new Map([['api-url', '   ']]),
      }),
    ).rejects.toThrow('--api-url needs a non-empty URL');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(configFilePath(dir))).toBe(false);
  });

  it('warns on stderr when KINJOT_API_KEY is already set, but still saves', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();
    const env = { ...process.env, KINJOT_API_KEY: 'kj_live_some_other_existing_env_key_value_x' };

    await runKey({ readHidden: async () => GOOD_KEY, stdout, stderr, env });

    expect(existsSync(configFilePath(dir))).toBe(true);
    expect(stderr.all()).toMatch(/KINJOT_API_KEY/);
    expect(stderr.all()).toMatch(/override/i);
  });

  it('piped stdin end-to-end: a non-TTY input stream saves the key without touching setRawMode', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();
    const input = new EventEmitter() as EventEmitter & {
      setRawMode: Mock<(mode: boolean) => void>;
      isTTY: boolean;
    };
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
  it('HELP mentions `kinjot key` and the global-install tip', async () => {
    const { HELP } = await import('./cli.js');
    expect(HELP).toContain('kinjot key');
    expect(HELP).toContain('npm i -g kinjot');
    expect(HELP).toContain('--api-url');
  });

  // README tells users a feature needs "0.4.3 or newer"; without this case
  // `kinjot --version` exited 1 with `unknown command`, so there was no way to
  // answer that question from the installed CLI.
  it.each(['--version', '-v', 'version'])('%s prints the running version', async (command) => {
    const { main, VERSION } = await import('./cli.js');
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
    process.exitCode = undefined;
    try {
      await main([command]);
    } finally {
      log.mockRestore();
    }
    expect(logs).toEqual([VERSION]);
    expect(process.exitCode).toBeUndefined();
  });

  it('HELP lists the version and help commands it accepts', async () => {
    const { HELP } = await import('./cli.js');
    expect(HELP).toContain('kinjot help');
    expect(HELP).toContain('kinjot --version');
  });

  it('runInit output includes the `kinjot key` tip and Codex command', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const logs: string[] = [];
    const logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation((...args) => void logs.push(args.join(' ')));
    const { main } = await import('./cli.js');
    try {
      await main(['init', '--key', GOOD_KEY]);
    } finally {
      logSpy.mockRestore();
      vi.unstubAllGlobals();
    }
    const output = logs.join('\n');
    expect(output).toMatch(/kinjot key/);
    expect(output).toContain(
      `claude mcp add kinjot -e KINJOT_API_KEY=${GOOD_KEY} -- npx -y kinjot`,
    );
    expect(output).toContain(
      `codex mcp add kinjot --env KINJOT_API_KEY=${GOOD_KEY} -- npx -y kinjot`,
    );
  });

  it('runInit omits KINJOT_API_URL for the legacy production endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const logs: string[] = [];
    const logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation((...args) => void logs.push(args.join(' ')));
    const { main } = await import('./cli.js');
    try {
      await main([
        'init',
        '--key',
        GOOD_KEY,
        '--api-url',
        'https://opzbxxrjiiktduivkdwm.supabase.co/functions/v1/mcp-api',
      ]);
    } finally {
      logSpy.mockRestore();
      vi.unstubAllGlobals();
    }
    expect(fetchMock).toHaveBeenCalledWith(DEFAULT_API_URL, expect.any(Object));
    expect(logs.join('\n')).not.toContain('KINJOT_API_URL');
  });

  it('runInit carries a custom endpoint into both client commands with shell-safe quoting', async () => {
    const apiUrl =
      "https://self-hosted.example/functions/v1/mcp-api?next=$(touch nope);owner=o'neil";
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const logs: string[] = [];
    const logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation((...args) => void logs.push(args.join(' ')));
    const previousApiUrl = process.env.KINJOT_API_URL;
    process.env.KINJOT_API_URL = apiUrl;
    const { main } = await import('./cli.js');
    try {
      await main(['init', '--key', GOOD_KEY]);
    } finally {
      if (previousApiUrl === undefined) delete process.env.KINJOT_API_URL;
      else process.env.KINJOT_API_URL = previousApiUrl;
      logSpy.mockRestore();
      vi.unstubAllGlobals();
    }

    const output = logs.join('\n');
    const quotedUrl = `'${apiUrl.replaceAll("'", `'"'"'`)}'`;
    expect(fetchMock).toHaveBeenCalledWith(apiUrl, expect.any(Object));
    expect(output).toContain(`"KINJOT_API_URL": ${JSON.stringify(apiUrl)}`);
    expect(output).toContain(
      `claude mcp add kinjot -e KINJOT_API_KEY=${GOOD_KEY} -e KINJOT_API_URL=${quotedUrl} -- npx -y kinjot`,
    );
    expect(output).toContain(
      `codex mcp add kinjot --env KINJOT_API_KEY=${GOOD_KEY} --env KINJOT_API_URL=${quotedUrl} -- npx -y kinjot`,
    );
  });

  it('runInit --api-url overrides KINJOT_API_URL and carries the selected endpoint through setup', async () => {
    const flagUrl = 'https://chosen.example/functions/v1/mcp-api';
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const logs: string[] = [];
    const logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation((...args) => void logs.push(args.join(' ')));
    const previousApiUrl = process.env.KINJOT_API_URL;
    process.env.KINJOT_API_URL = 'https://ignored.example/functions/v1/mcp-api';
    const { main } = await import('./cli.js');
    try {
      await main(['init', '--api-url', flagUrl, '--key', GOOD_KEY]);
    } finally {
      if (previousApiUrl === undefined) delete process.env.KINJOT_API_URL;
      else process.env.KINJOT_API_URL = previousApiUrl;
      logSpy.mockRestore();
      vi.unstubAllGlobals();
    }

    const output = logs.join('\n');
    expect(fetchMock).toHaveBeenCalledWith(flagUrl, expect.any(Object));
    expect(output).toContain(`"KINJOT_API_URL": "${flagUrl}"`);
    expect(output).not.toContain('ignored.example');
  });
});

/**
 * The endpoint has to travel with the key.
 *
 * `KINJOT_API_URL` is how a self-hosted deployment says "my project, not
 * kinjot's" (`docs/byo-supabase-setup.md` §MCP, in account mode). Both setup
 * commands print MCP client configurations for the user to paste, and a
 * printed configuration that carries the key but not the URL starts the server
 * against `DEFAULT_API_URL` — kinjot's production project — with a key minted
 * in someone else's. The key is rejected there, so the failure reads as a bad
 * key rather than a misrouted request, and the key has already been sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GOOD_KEY = `kj_live_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V'.slice(0, 43)}`;
const CUSTOMER_URL = 'https://customerproject.supabase.co/functions/v1/mcp-api';
/**
 * The generated commands are copy-pasted into a shell, so the endpoint is
 * single-quoted. Asserting the quoted form pins that: an unquoted value taken
 * from deployment configuration could otherwise carry shell syntax into a
 * command the user is being told to run.
 */
const QUOTED_URL = `'${CUSTOMER_URL}'`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let dir: string;
let previous: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinjot-endpoint-'));
  previous = {
    KINJOT_CONFIG_DIR: process.env.KINJOT_CONFIG_DIR,
    KINJOT_API_URL: process.env.KINJOT_API_URL,
    KINJOT_API_KEY: process.env.KINJOT_API_KEY,
  };
  process.env.KINJOT_CONFIG_DIR = dir;
  process.env.KINJOT_API_URL = CUSTOMER_URL;
  delete process.env.KINJOT_API_KEY;
});

afterEach(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('kinjot init, against a self-hosted deployment', () => {
  async function runInitCapturingOutput(): Promise<string> {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { notes: [] })),
    );
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    const { main } = await import('./cli.js');
    await main(['init', '--key', GOOD_KEY]);
    return lines.join('\n');
  }

  it('validates the key against the configured endpoint, not the default', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      void url;
      return jsonResponse(200, { notes: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { main } = await import('./cli.js');
    await main(['init', '--key', GOOD_KEY]);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(String(firstCall![0]).startsWith(CUSTOMER_URL)).toBe(true);
  });

  it('keeps the endpoint in the generated Claude Code command', async () => {
    const output = await runInitCapturingOutput();
    const command = output.split('\n').find((line) => line.startsWith('claude mcp add'));
    expect(command).toBeDefined();
    expect(command).toContain(`KINJOT_API_URL=${QUOTED_URL}`);
    expect(command).toContain(`KINJOT_API_KEY=${GOOD_KEY}`);
  });

  it('keeps the endpoint in the generated Codex command', async () => {
    const output = await runInitCapturingOutput();
    const command = output.split('\n').find((line) => line.startsWith('codex mcp add'));
    expect(command).toBeDefined();
    expect(command).toContain(`KINJOT_API_URL=${QUOTED_URL}`);
    expect(command).toContain(`KINJOT_API_KEY=${GOOD_KEY}`);
  });
});

describe('kinjot init, against the hosted default', () => {
  it('prints the commands unchanged, because the default already points there', async () => {
    delete process.env.KINJOT_API_URL;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { notes: [] })),
    );
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    const { main } = await import('./cli.js');
    await main(['init', '--key', GOOD_KEY]);
    const output = lines.join('\n');
    expect(output).toContain(
      `claude mcp add kinjot -e KINJOT_API_KEY=${GOOD_KEY} -- npx -y kinjot`,
    );
    expect(output).toContain(
      `codex mcp add kinjot --env KINJOT_API_KEY=${GOOD_KEY} -- npx -y kinjot`,
    );
    expect(output).not.toContain('KINJOT_API_URL');
  });
});

describe('kinjot key, against a self-hosted deployment', () => {
  it('carries the endpoint even though the key itself is stored on disk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { notes: [] })),
    );
    const lines: string[] = [];
    const stdout = { write: (chunk: string) => (lines.push(chunk), true) };
    const { runKey } = await import('./cli.js');
    await runKey({
      readHidden: async () => GOOD_KEY,
      stdout,
      stderr: { write: () => true },
      env: process.env,
    });
    const output = lines.join('');
    // The stored key removes the need for KINJOT_API_KEY. It does not remove
    // the need for the URL, which is not stored anywhere.
    expect(output).toContain(`KINJOT_API_URL=${QUOTED_URL}`);
  });
});

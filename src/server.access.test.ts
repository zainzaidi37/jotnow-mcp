import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { serveBackend } from './backend.js';
import { pointerPath } from './local/pointer.js';
import { serveStdio } from './server.js';

const KEY = `kj_live_${'A'.repeat(43)}`;
const ALL = [
  'append_to_jot',
  'edit_jot',
  'find_jots',
  'get_jot',
  'inbox',
  'jot',
  'list_recent_jots',
  'notify',
  'recall_jots',
  'upload_image',
];
const READ_CREATE = [
  'find_jots',
  'get_jot',
  'inbox',
  'jot',
  'list_recent_jots',
  'notify',
  'recall_jots',
  'upload_image',
];
const READ = ['find_jots', 'get_jot', 'inbox', 'list_recent_jots', 'recall_jots'];

// Each call gets an empty config directory of its own, so a key or mode that
// `kinjot key` / `kinjot use` stored on the machine running the suite can
// never reach resolution. It is stubbed into process.env as well as passed:
// resolveConfig's default stored-key loader reads configDir() from
// process.env, not from the env it is given.
let configDir: string;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

function writePointer(dir: string): void {
  writeFileSync(
    pointerPath(dir),
    JSON.stringify({
      version: 1,
      db_path: join(dir, 'local', 'library.db'),
      workspace_uuid: '11111111-1111-4111-8111-111111111111',
      schema_version: 2,
    }),
  );
}

async function toolNames(
  extraEnv: Record<string, string>,
  reply?: Response | 'network' | 'hang',
  setup?: (dir: string) => void,
) {
  configDir = mkdtempSync(join(tmpdir(), 'kinjot-access-'));
  vi.stubEnv('KINJOT_CONFIG_DIR', configDir);
  setup?.(configDir);
  const env = { KINJOT_CONFIG_DIR: configDir, ...extraEnv };
  const input = Object.assign(new PassThrough(), { isTTY: false });
  const output = new PassThrough();
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as unknown as typeof process.stdout);
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { action: string };
      requests.push(body.action);
      if (reply === 'network') throw new Error('offline');
      if (reply === 'hang') return new Promise<Response>(() => {});
      return reply ?? Response.json({ access: 'full' });
    }),
  );
  let pending = '';
  const replies = new Map<number, unknown>();
  output.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    while (pending.includes('\n')) {
      const newline = pending.indexOf('\n');
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const value = JSON.parse(line) as { id?: number };
      if (value.id !== undefined) replies.set(value.id, value);
    }
  });
  const started = Date.now();
  try {
    await serveStdio(serveBackend(env), 'test', env);
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'access-test', version: '1' },
        },
      })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const deadline = Date.now() + 500;
    while (!replies.has(2) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(replies.has(1)).toBe(true);
    const list = replies.get(2) as { result: { tools: { name: string }[] } };
    expect(list).toBeDefined();
    return {
      names: list.result.tools.map((tool) => tool.name).sort(),
      requests,
      elapsed: Date.now() - started,
    };
  } finally {
    input.destroy();
    output.destroy();
  }
}

it.each([
  ['read', READ],
  ['read_create', READ_CREATE],
  ['full', ALL],
] as const)('filters registered tools at startup for %s', async (level, expected) => {
  const result = await toolNames(
    { KINJOT_MODE: 'account', KINJOT_API_KEY: KEY, KINJOT_API_URL: 'https://api.example/mcp-api' },
    Response.json({ access: level }),
  );
  expect(result.names).toEqual(expected);
  expect(result.requests).toEqual(['key_info']);
});

it.each([
  ['old backend', Response.json({ error: 'unknown action' }, { status: 400 })],
  ['unauthorized', Response.json({ error: 'invalid or revoked API key' }, { status: 401 })],
  ['malformed', Response.json({ access: 'admin' })],
  ['network', 'network'],
  ['timeout', 'hang'],
] as const)(
  'keeps all tools on %s probe fallback',
  async (_name, reply) => {
    const result = await toolNames(
      {
        KINJOT_MODE: 'account',
        KINJOT_API_KEY: KEY,
        KINJOT_API_URL: 'https://api.example/mcp-api',
      },
      reply,
    );
    expect(result.names).toEqual(ALL);
    expect(result.requests).toEqual(['key_info']);
    expect(result.elapsed).toBeLessThan(2_000);
  },
  4_000,
);

it.each([
  ['missing key', { KINJOT_MODE: 'account' }, undefined],
  ['an invalid KINJOT_MODE', { KINJOT_MODE: 'invalid', KINJOT_API_KEY: KEY }, undefined],
  ['local mode', { KINJOT_MODE: 'local', KINJOT_API_KEY: KEY }, undefined],
  // Row 4 of mode.ts's precedence: a local library and a key, no mode chosen.
  // Resolution refuses, and that refusal must reach tools, not stop startup.
  ['a local library and a key with no mode chosen', { KINJOT_API_KEY: KEY }, writePointer],
] as const)('keeps all tools without a probe for %s', async (_name, env, setup) => {
  const result = await toolNames(env, undefined, setup);
  expect(result.names).toEqual(ALL);
  expect(result.requests).toEqual([]);
  expect(result.elapsed).toBeLessThan(500);
});

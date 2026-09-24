import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { main } from './cli.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it('starts the MCP stdio server through main and answers initialize with the package version', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: false });
  const output = new PassThrough();
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as unknown as typeof process.stdout);

  let timeout: ReturnType<typeof setTimeout>;
  const initialized = new Promise<{
    result?: { serverInfo?: { version?: string } };
    error?: unknown;
  }>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('MCP initialize timed out')), 2_000);
    let pending = '';
    output.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const newline = pending.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timeout);
      resolve(JSON.parse(pending.slice(0, newline)));
    });
  });

  try {
    await main([]);
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'cli-startup-test', version: '1.0.0' },
        },
      })}\n`,
    );
    const reply = await initialized;
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
    expect(reply.error).toBeUndefined();
    expect(reply.result?.serverInfo?.version).toBe(pkg.version);
    expect(process.exitCode).toBeUndefined();
  } finally {
    clearTimeout(timeout!);
    input.destroy();
    output.destroy();
  }
});

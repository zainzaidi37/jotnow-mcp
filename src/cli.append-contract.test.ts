import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesApi } from './api.js';
import { main } from './cli.js';

const GOOD_KEY = `jn_live_${'a'.repeat(43)}`;

describe('cli.append-contract', () => {
  let dir: string;
  const errors: string[] = [];
  const output: string[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jotnow-append-contract-'));
    vi.stubEnv('JOTNOW_CONFIG_DIR', dir);
    vi.stubEnv('JOTNOW_MODE', 'account');
    vi.stubEnv('JOTNOW_API_KEY', GOOD_KEY);
    errors.length = 0;
    output.length = 0;
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
    vi.spyOn(console, 'log').mockImplementation((...args) => void output.push(args.join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  function stdin(body: string) {
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Object.assign(Readable.from([Buffer.from(body)]), { isTTY: false }) as typeof process.stdin,
    );
  }
  it('reads piped text and echoes the returned handle and title', async () => {
    stdin('piped paragraph\n');
    const append = vi.spyOn(NotesApi.prototype, 'appendNote').mockResolvedValue({
      id: 'abc12345-1111-4111-8111-111111111111',
      short_id: 1,
      title: 'Target',
      updated_at: 'now',
    });
    await main(['append', 'A10']);
    expect(append).toHaveBeenCalledWith({ id: 'A10', text: 'piped paragraph\n', source: 'cli' });
    expect(output).toEqual(['Appended to A10 "Target".']);
  });
  it('uses --text and rejects unknown flags', async () => {
    stdin('ignored');
    const append = vi.spyOn(NotesApi.prototype, 'appendNote').mockResolvedValue({
      id: 'abc12345-1111-4111-8111-111111111111',
      title: 'Target',
      updated_at: 'now',
    });
    await main(['append', 'abc12345', '--text', 'explicit']);
    expect(append).toHaveBeenCalledWith({ id: 'abc12345', text: 'explicit', source: 'cli' });
    await main(['append', 'A10', '--typo', 'x']);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('unknown flag --typo');
    expect(append).toHaveBeenCalledTimes(1);
  });
  it('strips terminal controls from a backend-provided handle', async () => {
    stdin('text');
    vi.spyOn(NotesApi.prototype, 'appendNote').mockResolvedValue({
      id: '\u001b[31mxxx-1111-4111-8111-111111111111',
      title: 'Target',
      updated_at: 'now',
    });
    await main(['append', 'abc12345']);
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain('\u001b');
  });
  it('refuses local mode through the backend', async () => {
    vi.stubEnv('JOTNOW_MODE', 'local');
    stdin('text');
    await main(['append', 'A10']);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('not available in local mode');
  });
});

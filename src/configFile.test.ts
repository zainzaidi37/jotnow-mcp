import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configDir,
  configFilePath,
  loadStoredConfig,
  loadStoredKey,
  saveStoredAccount,
  saveStoredKey,
  saveStoredMode,
} from './configFile.js';

const GOOD_KEY = `jn_live_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V'.slice(0, 43)}`;

// chmod calls we make are our own code path (not OS enforcement), so they run
// identically as root; only skip on win32 where perms don't apply at all.
const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('configFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jotnow-cfg-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('save then load round-trips; the file is the documented { version, apiKey } shape', () => {
    saveStoredKey(GOOD_KEY, dir);
    const file = configFilePath(dir);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, apiKey: GOOD_KEY });
    expect(loadStoredKey(dir)).toBe(GOOD_KEY);
  });

  posixOnly('creates the dir at 0700 and the config file at 0600', () => {
    saveStoredKey(GOOD_KEY, dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(configFilePath(dir)).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind after a successful save (atomic rename)', () => {
    saveStoredKey(GOOD_KEY, dir);
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('returns undefined when no config file exists yet', () => {
    expect(loadStoredKey(dir)).toBeUndefined();
  });

  it('stores an endpoint with the key it was validated against', () => {
    const apiUrl = 'https://project.supabase.co/functions/v1/mcp-api';
    saveStoredAccount(GOOD_KEY, apiUrl, dir);
    expect(loadStoredConfig(dir)).toEqual({ apiKey: GOOD_KEY, apiUrl, mode: undefined });
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).version).toBe(2);
  });

  it('makes an older v1-only reader reject a custom endpoint pair before returning its key', () => {
    saveStoredAccount(GOOD_KEY, 'https://project.example/functions/v1/mcp-api', dir);
    const oldReader = () => {
      const record = JSON.parse(readFileSync(configFilePath(dir), 'utf8')) as {
        version?: unknown;
        apiKey?: unknown;
      };
      if (record.version !== 1) throw new Error('unexpected shape');
      return record.apiKey;
    };
    expect(oldReader).toThrow('unexpected shape');
  });

  it('switching from a self-host pair to a hosted key removes the endpoint and returns to v1', () => {
    saveStoredAccount(GOOD_KEY, 'https://project.example/functions/v1/mcp-api', dir);
    saveStoredKey(GOOD_KEY, dir);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8'))).toEqual({
      version: 1,
      apiKey: GOOD_KEY,
    });
  });

  it('rejects an endpoint in v1 and an unpaired endpoint config in v2', () => {
    const file = configFilePath(dir);
    writeFileSync(file, JSON.stringify({ version: 1, apiKey: GOOD_KEY, apiUrl: 'https://wrong.test' }));
    expect(() => loadStoredConfig(dir)).toThrow(/unexpected shape/);
    writeFileSync(file, JSON.stringify({ version: 2, apiUrl: 'https://wrong.test' }));
    expect(() => loadStoredConfig(dir)).toThrow(/unexpected shape/);
  });

  it('throws naming the file path when the JSON is corrupt', () => {
    const file = configFilePath(dir);
    writeFileSync(file, '{ not valid json');
    expect(() => loadStoredKey(dir)).toThrow(file);
    expect(() => loadStoredKey(dir)).toThrow(/jotnow key/);
  });

  it('throws naming the file path when the shape is wrong', () => {
    const file = configFilePath(dir);
    writeFileSync(file, JSON.stringify({ version: 1, notTheRightField: 'x' }));
    expect(() => loadStoredKey(dir)).toThrow(file);
  });

  it('`jotnow key` over a corrupt file recreates it — it is the documented repair path', () => {
    // The corrupt-file error says "Run `jotnow key` to recreate it", so the
    // write commands must never be blocked by the state they exist to repair.
    const file = configFilePath(dir);
    writeFileSync(file, '{ not valid json');
    saveStoredKey(GOOD_KEY, dir);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, apiKey: GOOD_KEY });
    expect(loadStoredKey(dir)).toBe(GOOD_KEY);
  });

  it('repairs an invalid v2 file to a valid v1 mode-only file', () => {
    const file = configFilePath(dir);
    writeFileSync(file, JSON.stringify({ version: 2, apiUrl: 'https://broken.example' }));
    saveStoredMode('local', dir);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, mode: 'local' });
    expect(loadStoredConfig(dir)).toEqual({ apiKey: undefined, apiUrl: undefined, mode: 'local' });
  });

  posixOnly('tightens loose file perms to 0600, warns on stderr, and still returns the key', () => {
    saveStoredKey(GOOD_KEY, dir);
    chmodSync(configFilePath(dir), 0o644);
    const stderrWrites: string[] = [];
    const fakeStderr = { write: (s: string) => (stderrWrites.push(s), true) };

    const key = loadStoredKey(dir, fakeStderr);

    expect(key).toBe(GOOD_KEY);
    expect(statSync(configFilePath(dir)).mode & 0o777).toBe(0o600);
    const warning = stderrWrites.join('');
    expect(warning).toMatch(/warn/i);
    expect(warning).toContain(configFilePath(dir));
    expect(warning).not.toContain(GOOD_KEY);
  });

  posixOnly('does not warn when the file is already 0600', () => {
    saveStoredKey(GOOD_KEY, dir);
    const stderrWrites: string[] = [];
    const fakeStderr = { write: (s: string) => (stderrWrites.push(s), true) };
    loadStoredKey(dir, fakeStderr);
    expect(stderrWrites).toEqual([]);
  });

  it('configDir honors the JOTNOW_CONFIG_DIR override', () => {
    expect(configDir({ JOTNOW_CONFIG_DIR: '/custom/path' })).toBe('/custom/path');
  });

  it('configDir defaults to ~/.jotnow (not XDG, not %APPDATA%)', () => {
    expect(configDir({})).toBe(join(homedir(), '.jotnow'));
  });
});

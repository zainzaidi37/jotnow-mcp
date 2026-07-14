import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configDir, configFilePath, loadStoredKey, saveStoredKey } from './configFile.js';

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

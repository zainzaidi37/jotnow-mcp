import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cachedMute, cachedMuteState, refreshMute } from './inbox-cache.js';

const config = { apiUrl: 'https://api.example/mcp-api', apiKey: `kj_live_${'A'.repeat(43)}` };
const answer = {
  id: '1a2b3c4d-1111-4111-8111-111111111111',
  status: 'muted' as const,
  repeat_count: 0,
  send_kinds: ['handoff'],
  key_muted: false,
  truncated: [],
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('serves a muted kind just inside one hour and expires it at one hour', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinjot-cache-'));
  dirs.push(dir);
  refreshMute(dir, config, answer, 10_000);
  expect(cachedMute(dir, config, 'question', 10_000 + 3_600_000 - 1)).toBe(true);
  expect(cachedMute(dir, config, 'question', 10_000 + 3_600_000)).toBe(false);
  expect(cachedMute(dir, config, 'handoff', 10_001)).toBe(false);
  expect(cachedMuteState(dir, config, 'question', 10_000 + 3_600_000 - 1)).toBe('muted');
  expect(cachedMuteState(dir, config, 'handoff', 10_001)).toBe('enabled');
  expect(cachedMuteState(dir, config, 'question', 10_000 + 3_600_000)).toBe('unknown');
});

it('treats missing key_muted and non-string send_kinds as unknown cache state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinjot-cache-'));
  dirs.push(dir);
  const path = join(dir, 'inbox-cache.json');
  const key = `${config.apiUrl}\n${config.apiKey.slice(0, 16)}`;
  writeFileSync(path, JSON.stringify({ [key]: { at: 10_000, send_kinds: ['waiting'] } }));
  expect(cachedMuteState(dir, config, 'waiting', 10_000)).toBe('unknown');

  writeFileSync(
    path,
    JSON.stringify({ [key]: { at: 10_000, send_kinds: ['waiting', 42], key_muted: false } }),
  );
  expect(cachedMuteState(dir, config, 'waiting', 10_000)).toBe('unknown');
});

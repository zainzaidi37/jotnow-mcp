import { describe, expect, it } from 'vitest';
import { DEFAULT_API_URL, resolveConfig } from './config.js';

const key = `jn_live_${'a'.repeat(43)}`;
const legacy = 'https://opzbxxrjiiktduivkdwm.supabase.co/functions/v1/mcp-api';

describe('production endpoint region', () => {
  it('pins the default MCP API beside the database', () => {
    expect(DEFAULT_API_URL).toBe(`${legacy}?forceFunctionRegion=us-east-1`);
    expect(resolveConfig({ JOTNOW_API_KEY: key }).apiUrl).toBe(DEFAULT_API_URL);
  });

  it('upgrades a legacy production URL from saved config or environment', () => {
    expect(resolveConfig({}, () => ({ apiKey: key, apiUrl: legacy })).apiUrl).toBe(DEFAULT_API_URL);
    expect(resolveConfig({ JOTNOW_API_KEY: key, JOTNOW_API_URL: legacy }).apiUrl).toBe(
      DEFAULT_API_URL,
    );
  });

  it('leaves custom and self-host endpoints untouched', () => {
    const custom = 'https://customerproject.supabase.co/functions/v1/mcp-api?mode=test';
    expect(resolveConfig({ JOTNOW_API_KEY: key, JOTNOW_API_URL: custom }).apiUrl).toBe(custom);
  });
});

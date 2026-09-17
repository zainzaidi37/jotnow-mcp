// Configuration comes from environment variables (so the same values work in
// an MCP server entry's "env" block and a shell) or the stored key file
// written by `jotnow key` (see configFile.ts). The API key is the only
// secret; it is a user-scoped key from the web app's settings page — the
// Supabase service-role key must never appear anywhere in this package.

import { configDir, configFilePath, loadStoredConfig } from './configFile.js';

export const DEFAULT_API_URL =
  'https://opzbxxrjiiktduivkdwm.supabase.co/functions/v1/mcp-api';

export const API_KEY_PATTERN = /^jn_live_[A-Za-z0-9]{43}$/;

export interface Config {
  apiUrl: string;
  apiKey: string;
}

interface StoredAccountConfig {
  apiKey?: string;
  apiUrl?: string;
}

function defaultLoadStored(): StoredAccountConfig {
  return loadStoredConfig(configDir());
}

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
  loadStored: () => StoredAccountConfig | string | undefined = defaultLoadStored,
): Config {
  const explicitApiUrl = env.JOTNOW_API_URL?.trim() || undefined;
  const envKey = env.JOTNOW_API_KEY?.trim() ?? '';

  if (envKey !== '') {
    // No fallback to a stored key here: silently using a different key than
    // the one the user thinks they set could write to the wrong account.
    if (!API_KEY_PATTERN.test(envKey)) {
      throw new Error(
        'JOTNOW_API_KEY does not look like a jotnow key (expected jn_live_ + 43 characters). ' +
          'It overrides any stored key, so the stored key (if any) will not be used until this is fixed or unset.',
      );
    }
    return { apiUrl: explicitApiUrl ?? DEFAULT_API_URL, apiKey: envKey };
  }

  const loaded = loadStored();
  const stored = typeof loaded === 'string' ? { apiKey: loaded } : loaded;
  if (stored?.apiKey === undefined) {
    throw new Error('No API key found. Run `jotnow key` to set one up, or set JOTNOW_API_KEY.');
  }
  if (!API_KEY_PATTERN.test(stored.apiKey)) {
    throw new Error(
      `The key stored in ${configFilePath(configDir(env))} does not look like a jotnow key. Run \`jotnow key\` to set a new one.`,
    );
  }
  return {
    apiUrl: explicitApiUrl ?? stored.apiUrl ?? DEFAULT_API_URL,
    apiKey: stored.apiKey,
  };
}

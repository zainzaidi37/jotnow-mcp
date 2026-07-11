// Configuration comes from environment variables so the same values work in
// an MCP server entry ("env" block) and a shell. The API key is the only
// secret; it is a user-scoped key from the web app's settings page — the
// Supabase service-role key must never appear anywhere in this package.

export const DEFAULT_API_URL =
  'https://opzbxxrjiiktduivkdwm.supabase.co/functions/v1/mcp-api';

export const API_KEY_PATTERN = /^jn_live_[A-Za-z0-9]{43}$/;

export interface Config {
  apiUrl: string;
  apiKey: string;
}

export function resolveConfig(env: Record<string, string | undefined> = process.env): Config {
  const apiKey = env.JOTNOW_API_KEY?.trim() ?? '';
  if (apiKey === '') {
    throw new Error(
      'JOTNOW_API_KEY is not set. Create a key in the jotnow web app ' +
        '(Settings → API keys), then run: npx jotnow init --key jn_live_...',
    );
  }
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error(
      'JOTNOW_API_KEY does not look like a jotnow key (expected jn_live_ + 43 characters).',
    );
  }
  return { apiUrl: env.JOTNOW_API_URL?.trim() || DEFAULT_API_URL, apiKey };
}

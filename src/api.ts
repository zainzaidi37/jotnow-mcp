import type { Config } from './config.js';
import { normalizeTags } from './tagging.js';

// Thin client for the mcp-api Edge Function. Note ids are generated here —
// UUIDs are client-generated throughout jotnow.

// Listings (search and recent) are deliberately compact: no bodies. A body
// only enters the caller's context when it explicitly fetches one note via
// getNote.
export interface SearchHit {
  id: string;
  title: string;
  tags: string[];
  updated_at: string;
  // Populated for search_notes and list_recent_notes results, and only when
  // the caller is on the Pro plan (the mcp_* RPCs gate it server-side on the
  // current plan, not on embedding-row presence).
  gist?: string | null;
}

export interface SearchResult {
  notes: SearchHit[];
  total: number;
}

export interface FullNote {
  id: string;
  title: string;
  body: string;
  folder_id: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  tags: string[];
}

// Semantic retrieval candidates: compact like SearchHit, plus the one-line
// gist written at embed time and the cosine similarity for calibration.
export interface RecallMatch {
  id: string;
  title: string;
  gist: string | null;
  similarity: number;
}

export interface SaveNoteInput {
  title: string;
  body: string;
  tags?: string[];
  folder?: string;
  source?: 'mcp' | 'cli';
  vocabulary?: string[];
}

export interface SavedNote {
  id: string;
  title: string;
  created_at: string;
  tags: string[];
  existingTags?: string[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NotesApi {
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async saveNote(input: SaveNoteInput): Promise<SavedNote> {
    const tags = input.tags ? normalizeTags(input.tags, input.vocabulary) : [];
    const response = await this.call('save_note', {
      id: crypto.randomUUID(),
      title: input.title,
      body: input.body,
      // Normalized here, the single choke point, so the CLI and the MCP
      // tool can't disagree on tag hygiene.
      tags: input.tags ? tags : undefined,
      folder: input.folder,
      source: input.source ?? 'mcp',
    });
    const result = response as {
      note: { id: string; title: string; created_at: string };
      existing_tags?: unknown;
    };
    const existingTags = Array.isArray(result.existing_tags) &&
        result.existing_tags.every((tag) => typeof tag === 'string')
      ? result.existing_tags
      : undefined;
    return { ...result.note, tags, existingTags };
  }

  async listRecentNotes(limit = 10): Promise<SearchHit[]> {
    const result = await this.call('list_recent_notes', { limit });
    return (result as { notes: SearchHit[] }).notes;
  }

  async searchNotes(query: string): Promise<SearchResult> {
    return (await this.call('search_notes', { query })) as SearchResult;
  }

  async recallNotes(query: string): Promise<RecallMatch[]> {
    const result = await this.call('recall', { query });
    return (result as { matches: RecallMatch[] }).matches;
  }

  async getNote(id: string): Promise<FullNote> {
    const result = await this.call('get_note', { id });
    return (result as { note: FullNote }).note;
  }

  private async call(action: string, params: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ action, ...params }),
      });
    } catch (cause) {
      throw new ApiError(0, `could not reach ${this.config.apiUrl}: ${(cause as Error).message}`);
    }

    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      if (response.status === 401) {
        throw new ApiError(401, 'API key was rejected — it may have been revoked. Create a new one in Settings → API keys.');
      }
      if (response.status === 429) {
        throw new ApiError(429, 'rate limit hit (60 writes/min per key); wait a minute and retry.');
      }
      throw new ApiError(response.status, body?.error ?? `request failed with ${response.status}`);
    }
    return body;
  }
}

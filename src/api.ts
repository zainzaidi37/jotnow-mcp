import type { z } from 'zod';
import { wireSchemas } from './wire.js';
import type { Config } from './config.js';
import { normalizeTags } from './tagging.js';
import { parseNoteLabel } from './core/note-label.js';

// Thin client for the mcp-api Edge Function. Note ids are generated here —
// UUIDs are client-generated throughout jotnow.

// Listings (search and recent) are deliberately compact: no bodies. A body
// only enters the caller's context when it explicitly fetches one note via
// getNote.
export interface SearchHit {
  id: string;
  short_id?: number | null;
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
  short_id?: number | null;
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
  short_id?: number | null;
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

export interface EditNoteInput {
  id: string;
  old_string?: string;
  new_string?: string;
  title?: string;
  add_tags?: string[];
  remove_tags?: string[];
  folder?: string;
  source?: 'mcp' | 'cli';
  vocabulary?: string[];
}

export interface AppendNoteInput {
  id: string;
  text: string;
  source?: 'mcp' | 'cli';
}

export interface EditedNote {
  id: string;
  short_id?: number | null;
  title: string;
  updated_at: string;
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
    const response = await this.call('save_note', wireSchemas.save_note, {
      id: crypto.randomUUID(),
      title: input.title,
      body: input.body,
      // Normalized here, the single choke point, so the CLI and the MCP
      // tool can't disagree on tag hygiene.
      tags: input.tags ? tags : undefined,
      folder: input.folder,
      source: input.source ?? 'mcp',
    });
    return { ...response.note, tags, existingTags: response.existing_tags };
  }

  async listRecentNotes(limit = 10): Promise<SearchHit[]> {
    const result = await this.call('list_recent_notes', wireSchemas.list_recent_notes, { limit });
    return result.notes;
  }

  async searchNotes(query: string): Promise<SearchResult> {
    return await this.call('search_notes', wireSchemas.search_notes, { query });
  }

  async recallNotes(query: string): Promise<RecallMatch[]> {
    const result = await this.call('recall', wireSchemas.recall, { query });
    return result.matches;
  }

  async getNote(input: string): Promise<FullNote> {
    const shortId = parseNoteLabel(input.trim());
    try {
      const result = await this.call(
        'get_note',
        wireSchemas.get_note,
        shortId === null ? { id: input } : { short_id: shortId },
      );
      return result.note;
    } catch (error) {
      if (shortId !== null && error instanceof ApiError && error.status === 400) {
        throw new ApiError(
          400,
          'This Jotnow backend does not support short ids yet; use the 8-character id prefix instead.',
        );
      }
      throw error;
    }
  }

  async editNote(input: EditNoteInput): Promise<EditedNote> {
    const shortId = parseNoteLabel(input.id.trim());
    const reference = shortId === null ? { id: input.id } : { short_id: shortId };
    try {
      const result = await this.call('edit_note', wireSchemas.edit_note, {
        ...reference,
        old_string: input.old_string,
        new_string: input.new_string,
        title: input.title,
        add_tags: input.add_tags ? normalizeTags(input.add_tags, input.vocabulary) : undefined,
        remove_tags: input.remove_tags?.map((tag) => tag.trim().replace(/^#+/, '').toLowerCase()),
        folder: input.folder,
        source: input.source ?? 'mcp',
      });
      return result.note;
    } catch (error) {
      throw this.agentEditError(error);
    }
  }

  async appendNote(input: AppendNoteInput): Promise<EditedNote> {
    const shortId = parseNoteLabel(input.id.trim());
    try {
      const result = await this.call('append_note', wireSchemas.append_note, {
        ...(shortId === null ? { id: input.id } : { short_id: shortId }),
        text: input.text,
        source: input.source ?? 'mcp',
      });
      return result.note;
    } catch (error) {
      throw this.agentEditError(error);
    }
  }

  private agentEditError(error: unknown): unknown {
    if (!(error instanceof ApiError)) return error;
    if (error.status === 400 && error.message === 'unknown action') {
      return new ApiError(
        400,
        'This Jotnow backend does not support agent edits yet; update the deployment.',
      );
    }
    if (error.status === 409 && error.message.includes('old_string must match exactly')) {
      return new ApiError(
        409,
        'Re-read the note with get_jot and choose an anchor that matches exactly, including whitespace and line endings, and occurs exactly once.',
      );
    }
    if (error.status === 409 && error.message.includes('old_string occurs more than once')) {
      return new ApiError(
        409,
        'Re-read the note with get_jot and choose a longer anchor that occurs exactly once.',
      );
    }
    return error;
  }

  private async call<T>(
    action: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    params: Record<string, unknown>,
  ): Promise<T> {
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
        throw new ApiError(
          401,
          'API key was rejected — it may have been revoked. Create a new one in Settings → API keys.',
        );
      }
      if (response.status === 429) {
        throw new ApiError(429, 'rate limit hit (60 writes/min per key); wait a minute and retry.');
      }
      throw new ApiError(response.status, body?.error ?? `request failed with ${response.status}`);
    }
    const invalidReply = (detail: string) =>
      new ApiError(
        response.status,
        `${this.config.apiUrl} answered ${action}: ${detail}. Please update the CLI (npm i -g jotnow) or, on a self-hosted deployment, update the backend.`,
      );
    if (body === null) throw invalidReply('no JSON response this version of jotnow understands');
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw invalidReply('a response this version of jotnow does not understand');
    return parsed.data;
  }
}

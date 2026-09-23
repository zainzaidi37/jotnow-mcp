import { z } from 'zod';

// Public mcp-api envelopes, deliberately looser than database row schemas:
// ids/timestamps/source are strings and additive server fields are tolerated.
const searchHit = z.object({
  id: z.string(),
  short_id: z.number().int().nullable().optional(),
  title: z.string(),
  tags: z.array(z.string()),
  updated_at: z.string(),
  gist: z.string().nullable().optional(),
});

export const wireSchemas = {
  save_note: z.object({
    note: z.object({ id: z.string(), title: z.string(), created_at: z.string() }),
    // This vocabulary hint has always been best-effort, including malformed
    // hints from old deployments. It must never prevent a successful save.
    existing_tags: z.array(z.string()).optional().catch(undefined),
  }),
  list_recent_notes: z.object({ notes: z.array(searchHit) }),
  search_notes: z.object({ notes: z.array(searchHit), total: z.number() }),
  recall: z.object({
    matches: z.array(
      z.object({
        id: z.string(),
        short_id: z.number().int().nullable().optional(),
        title: z.string(),
        gist: z.string().nullable(),
        similarity: z.number(),
      }),
    ),
  }),
  get_note: z.object({
    note: z.object({
      id: z.string(),
      short_id: z.number().int().nullable().optional(),
      title: z.string(),
      body: z.string(),
      folder_id: z.string().nullable(),
      source: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
      tags: z.array(z.string()),
    }),
  }),
};

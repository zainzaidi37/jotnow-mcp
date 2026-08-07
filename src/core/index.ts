// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/index.ts, emitted by
// `pnpm --filter @jotnow/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

import { z } from 'zod';

// Canonical data model. Mirrors the Postgres schema exactly (see
// docs/technical-plan.md, Phase 0). Timestamps are ISO-8601 strings as
// returned by Postgres timestamptz columns; `updated_at` is always set
// server-side (Postgres trigger in Phase 2+).

export const NOTE_SOURCES = ['web', 'mcp', 'cli', 'vscode'] as const;

const uuid = z.string().uuid();
const timestamptz = z.string().datetime({ offset: true });

/**
 * A jsonb column whose shape belongs to its writer. Deliberately not
 * `z.unknown()`: that accepts *any* value including `undefined`, which makes
 * the object key optional, so a row missing the column entirely would parse.
 * A jsonb column is always present in a server row — null or a value.
 */
const jsonbValue = z.custom<unknown>((value) => value !== undefined, {
  message: 'Required',
});

/**
 * The pull cursor's ordering key (plans/sync-cursor-fence.md): the xid8 of the
 * transaction that last wrote the row, as a bigint. Server-set by a Postgres
 * trigger, exactly like `updated_at` — clients never write it.
 *
 * Nullable, and required rather than optional, in the *local* schemas: null
 * means "no server revision yet". A row that has never been synced has no
 * transaction id to carry, and Phase 4 reads null as "must not exist on the
 * server". Optional would add an `undefined` third state that means the same
 * thing, so the type is `number | null` and every construction site must say
 * which it is. Rows read back from the server always carry one — see the
 * `Server*` schemas below.
 *
 * Number, not bigint: xid8 is `epoch << 32 | xid`, so passing
 * Number.MAX_SAFE_INTEGER takes roughly 9e15 transactions.
 */
const syncSeq = z.number().int();

export const NoteSchema = z.object({
  id: uuid,
  user_id: uuid,
  title: z.string(),
  body: z.string(),
  folder_id: uuid.nullable(),
  source: z.enum(NOTE_SOURCES),
  /**
   * A note holds at most one pin, scoped to exactly one view: All Notes
   * (`pinned_in` null) or a single folder (`pinned_in` = that folder's id).
   * `pinned_at` set = pinned, and orders pinned notes (most recent first).
   * Client-written like `deleted_at` — an ordering preference, not a sync
   * cursor.
   */
  pinned_at: timestamptz.nullable(),
  pinned_in: uuid.nullable(),
  sync_seq: syncSeq.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type Note = z.infer<typeof NoteSchema>;
export type NoteSource = Note['source'];

export const FolderSchema = z.object({
  id: uuid,
  user_id: uuid,
  name: z.string().min(1),
  parent_id: uuid.nullable(),
  sync_seq: syncSeq.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type Folder = z.infer<typeof FolderSchema>;

export const TagSchema = z.object({
  id: uuid,
  user_id: uuid,
  name: z.string().min(1),
  sync_seq: syncSeq.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type Tag = z.infer<typeof TagSchema>;

export const EXPORT_FORMAT_VERSION = 2;

// V1 is frozen because real export files on users' disks are validated against it.
export const ExportManifestV1Schema = z
  .object({
    formatVersion: z.number().int().positive(),
    exportedAt: NoteSchema.shape.created_at,
    fileFormat: z.enum(['frontmatter', 'clean']),
    folders: z
      .object({
        id: FolderSchema.shape.id,
        parentId: FolderSchema.shape.parent_id,
        name: z.string(),
      })
      .strict()
      .array(),
    tags: z
      .object({
        id: TagSchema.shape.id,
        name: z.string(),
      })
      .strict()
      .array(),
    notes: z
      .object({
        id: NoteSchema.shape.id,
        folderId: NoteSchema.shape.folder_id,
        path: z.string().min(1),
        title: z.string(),
        tagIds: TagSchema.shape.id.array(),
        source: NoteSchema.shape.source,
        created: NoteSchema.shape.created_at,
        updated: NoteSchema.shape.updated_at,
      })
      .strict()
      .array(),
  })
  .strict();
export type ExportManifestV1 = z.infer<typeof ExportManifestV1Schema>;

/** Version sidecar paths are constrained, never free-form — see below. */
export const EXPORT_VERSION_FILE_PATH =
  /^versions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

// V1 deliberately accepts any positive integer; the dispatcher gates it, while v2 is literal.
export const ExportManifestV2Schema = z
  .object({
    formatVersion: z.literal(2),
    exportedAt: ExportManifestV1Schema.shape.exportedAt,
    fileFormat: ExportManifestV1Schema.shape.fileFormat,
    folders: ExportManifestV1Schema.shape.folders,
    tags: ExportManifestV1Schema.shape.tags,
    notes: ExportManifestV1Schema.shape.notes.element
      .extend({
        pinnedAt: NoteSchema.shape.pinned_at,
        pinnedIn: NoteSchema.shape.pinned_in,
      })
      .strict()
      .array(),
    versionFiles: z
      .object({
        noteId: uuid,
        path: z.string().regex(EXPORT_VERSION_FILE_PATH),
        count: z.number().int().nonnegative(),
      })
      .strict()
      .array(),
    history: z
      .object({
        included: z.boolean(),
        reason: z.enum(['excluded', 'offline', 'unavailable', 'recording-off']).optional(),
      })
      .strict(),
  })
  .strict();
export type ExportManifestV2 = z.infer<typeof ExportManifestV2Schema>;

/** One note's full version history, newest first. Written to versions/<noteId>.json. */
export const ExportNoteVersionsFileSchema = z
  .object({
    noteId: uuid,
    versions: z
      .object({
        id: uuid,
        title: z.string(),
        body: z.string(),
        created: NoteSchema.shape.created_at,
      })
      .strict()
      .array(),
  })
  .strict();
export type ExportNoteVersionsFile = z.infer<typeof ExportNoteVersionsFileSchema>;

export const ExportManifestSchema = ExportManifestV2Schema;
export type ExportManifest = ExportManifestV2;

// API keys for MCP/CLI access. The full key is shown once at creation; only
// its SHA-256 hex digest is stored. Column grants hide key_hash from clients,
// so reads use ApiKeyPublicSchema; the full schema exists for the Edge
// Function and for the one insert that stores the hash.
export const ApiKeySchema = z.object({
  id: uuid,
  user_id: uuid,
  name: z.string().min(1),
  key_prefix: z.string().min(1),
  key_hash: z.string().regex(/^[0-9a-f]{64}$/),
  last_used_at: timestamptz.nullable(),
  revoked_at: timestamptz.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const ApiKeyPublicSchema = ApiKeySchema.omit({ key_hash: true });
export type ApiKeyPublic = z.infer<typeof ApiKeyPublicSchema>;

// API key format, shared by the web app (generation), the Edge Function
// (validation), and jotnow (client-side validation). A key is
// "jn_live_" + 43 base62 characters (~256 bits); the stored prefix is the
// first 16 characters, enough to recognize a key without revealing it.
export const API_KEY_PATTERN = /^jn_live_[A-Za-z0-9]{43}$/;
export const API_KEY_PREFIX_LENGTH = 16;

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateApiKey(): string {
  const chars: string[] = [];
  while (chars.length < 43) {
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // Rejection sampling: 248 = 4 * 62, so bytes below it map uniformly.
      if (byte < 248 && chars.length < 43) chars.push(KEY_ALPHABET[byte % 62]!);
    }
  }
  return `jn_live_${chars.join('')}`;
}

export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX_LENGTH);
}

/** SHA-256 hex digest — the only form of a key ever stored server-side. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Entitlements: one profile per auth user, auto-created at signup by a
// Postgres trigger. plan is server-authoritative — clients can only read
// their own row; changes come from the billing webhook (service role).
export const PLANS = ['free', 'pro'] as const;

export const ProfileSchema = z.object({
  user_id: uuid,
  plan: z.enum(PLANS),
  /** Provider event timestamp that last set plan (out-of-order guard). */
  plan_event_at: timestamptz.nullable(),
  /**
   * Opt-in version recording (off by default). The one profiles column
   * clients may write — a column-level grant scoped to their own row; the
   * capture trigger reads it server-side, so it gates web and MCP edits alike.
   */
  version_history_enabled: z.boolean(),
  /** Allow tidiness runs to create folders when needed. */
  tidy_create_folders: z.boolean(),
  /** Allow tidiness runs to create tags when needed. */
  tidy_create_tags: z.boolean(),
  /** Allow manual tidiness runs to merge equivalent tags. */
  tidy_merge_tags: z.boolean(),
  /**
   * The billing provider's subscription reference, written by the webhook.
   * Hidden from clients by column grants, so client-side rows never include
   * it — optional so parsing a client-visible row still works.
   */
  billing_ref: z.string().nullable().optional(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type Profile = z.infer<typeof ProfileSchema>;
export type Plan = Profile['plan'];

// Phase 4 AI recall. These tables are server-managed: only Edge Functions
// (service role) write them; clients at most read their own rows. The
// schemas mirror the SQL exactly — `embedding` is pgvector vector(1024)
// serialized as a JSON number array at the PostgREST boundary.
export const EMBEDDING_DIM = 1024;

// No deleted_at on either derived table: embeddings and queue rows are
// hard-deleted (a soft-deleted embedding would retain a representation of
// content the user discarded) — see the migration for the full rationale.
export const NoteEmbeddingSchema = z.object({
  note_id: uuid,
  user_id: uuid,
  embedding: z.array(z.number()).length(EMBEDDING_DIM),
  created_at: timestamptz,
  updated_at: timestamptz,
});
export type NoteEmbedding = z.infer<typeof NoteEmbeddingSchema>;

export const EmbeddingJobSchema = z.object({
  note_id: uuid,
  user_id: uuid,
  attempts: z.number().int(),
  created_at: timestamptz,
  updated_at: timestamptz,
});
export type EmbeddingJob = z.infer<typeof EmbeddingJobSchema>;

// Phase 5 Tidiness. Run and change rows are user content fetched on demand;
// tidy_jobs is rebuildable server-only queue state.
export const TIDY_TRIGGERS = ['manual', 'capture', 'prompted'] as const;
export const TIDY_RUN_STATUSES = [
  'running',
  'pending_confirm',
  'applied',
  'failed',
  'reverted',
] as const;
export const TIDY_CHANGE_KINDS = [
  'create_folder',
  'create_tag',
  'move_note',
  'retag_note',
  'merge_tags',
] as const;

export const TidyRunSchema = z.object({
  id: uuid,
  user_id: uuid,
  trigger: z.enum(TIDY_TRIGGERS),
  status: z.enum(TIDY_RUN_STATUSES),
  model: z.string().nullable(),
  note_count: z.number().int(),
  change_count: z.number().int(),
  skipped_count: z.number().int(),
  error: z.string().nullable(),
  /** Prompted runs only: the user's words. Always rendered as plain text. */
  instruction: z.string().nullable(),
  /** The plan a paused run is holding; shape is owned by the Edge Function. */
  pending_plan: jsonbValue.nullable(),
  pending_expires_at: timestamptz.nullable(),
  /** Stamped by resume_tidy_run — the user's consent to a paused plan. */
  confirmed_at: timestamptz.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type TidyRun = z.infer<typeof TidyRunSchema>;

/**
 * What the confirm card shows. Everything *rendered* is a denormalized name,
 * because the UI renders it as plain text. The one id here is never displayed:
 * a merge is approved by its winner (`merge_winner_ids` on the confirm request)
 * and names are not a key — two tags can differ only by case, and a winner can
 * be a tag the same plan is about to create, so it has no id the client could
 * look up locally. The last three fields are zero-defaulted: the manual pause
 * happens before assignments are planned and cannot know them.
 */
export const TidyPendingSummarySchema = z.object({
  merges: z.array(
    z.object({
      winner_tag_id: uuid,
      winner_name: z.string(),
      loser_names: z.array(z.string()),
    }),
  ),
  create_folders: z.array(z.object({ name: z.string() })),
  create_tags: z.array(z.object({ name: z.string() })),
  moves_by_destination: z
    .array(z.object({ folder_name: z.string(), count: z.number().int().nonnegative() }))
    .default([]),
  retag_note_count: z.number().int().nonnegative().default(0),
  removal_count: z.number().int().nonnegative().default(0),
});
export type TidyPendingSummary = z.infer<typeof TidyPendingSummarySchema>;

/**
 * Which shape of pause a `pending_confirm` run is holding, and therefore which
 * card the user is owed. A manual pause stops after the taxonomy call and its
 * ops are individually vetoable; a prompted pause holds a whole planned run and
 * is all-or-nothing, because its moves and tag removals have no name-shaped
 * tick-box the approval vocabulary could carry.
 *
 * Deliberately *not* on the `pending_confirm` stream event: the client already
 * knows which mode it started, and the server only ever pauses a manual run as
 * `manual_taxonomy` and a prompted run as `prompted_full`. Putting it on the
 * wire would add a field the SPA and the Edge Function have to agree on across
 * a non-atomic deploy, to say something the client cannot get wrong. Recovery
 * from a run row reads it off the stored `pending_plan`, which is authoritative.
 */
export const TIDY_PENDING_KINDS = ['manual_taxonomy', 'prompted_full'] as const;
export type TidyPendingKind = (typeof TIDY_PENDING_KINDS)[number];

/**
 * How long a prompted instruction may be. The enforcing copy is
 * `supabase/functions/_shared/tidy-plan.ts` (Deno cannot import this package);
 * this one exists so the client can say the limit before spending a round trip
 * on a 413. Keep the two in step.
 */
export const MAX_TIDY_INSTRUCTION_CHARS = 500;

/** A planner declining an instruction it cannot serve inside the op vocabulary. */
export const TidyRefusalSchema = z.object({ refusal: z.string() });
export type TidyRefusal = z.infer<typeof TidyRefusalSchema>;

/** The engine's identity for an `error` frame, when it has one worth telling
 * apart. `refused` is the planner declining an instruction — an answer, not a
 * fault, and never a charge. Compared by value at the point of use rather than
 * enumerated on the wire: see the `error` event's schema. */
export const TIDY_REFUSED_CODE = 'refused';

const TidyCreateFolderPayloadSchema = z.object({
  kind: z.literal('create_folder'),
  folder_id: uuid,
  name: z.string(),
  parent_id: uuid.nullable(),
});
const TidyCreateTagPayloadSchema = z.object({
  kind: z.literal('create_tag'),
  tag_id: uuid,
  name: z.string(),
});
const TidyMoveNotePayloadSchema = z.object({
  kind: z.literal('move_note'),
  note_id: uuid,
  note_title: z.string(),
  from_folder_id: uuid.nullable(),
  to_folder_id: uuid.nullable(),
  to_folder_name: z.string().nullable(),
  pin_cleared: z.boolean(),
  pinned_at: timestamptz.nullable(),
  pinned_in: uuid.nullable(),
});
const TidyRetagNotePayloadSchema = z.object({
  kind: z.literal('retag_note'),
  note_id: uuid,
  note_title: z.string(),
  added: z.array(
    z.object({
      tag_id: uuid,
      name: z.string(),
      link_revived: z.boolean(),
    }),
  ),
  removed: z.array(z.object({ tag_id: uuid, name: z.string() })),
});
const TidyMergeTagsPayloadSchema = z.object({
  kind: z.literal('merge_tags'),
  winner_tag_id: uuid,
  winner_name: z.string(),
  losers: z.array(
    z.object({
      tag_id: uuid,
      name: z.string(),
      moved: z.array(z.object({ note_id: uuid, winner_link_created: z.boolean() })),
    }),
  ),
});

export const TidyChangePayloadSchema = z.discriminatedUnion('kind', [
  TidyCreateFolderPayloadSchema,
  TidyCreateTagPayloadSchema,
  TidyMoveNotePayloadSchema,
  TidyRetagNotePayloadSchema,
  TidyMergeTagsPayloadSchema,
]);
export type TidyChangePayload = z.infer<typeof TidyChangePayloadSchema>;

export const TidyChangeSchema = z
  .object({
    id: uuid,
    run_id: uuid,
    user_id: uuid,
    seq: z.number().int(),
    kind: z.enum(TIDY_CHANGE_KINDS),
    payload: TidyChangePayloadSchema,
    result: z.unknown().nullable(),
    reverted_at: timestamptz.nullable(),
    created_at: timestamptz,
    updated_at: timestamptz,
    deleted_at: timestamptz.nullable(),
  })
  .refine((change) => change.kind === change.payload.kind, {
    message: 'kind must match payload.kind',
    path: ['payload', 'kind'],
  });
export type TidyChange = z.infer<typeof TidyChangeSchema>;

export const TidyJobSchema = z.object({
  note_id: uuid,
  user_id: uuid,
  attempts: z.number().int(),
  created_at: timestamptz,
  updated_at: timestamptz,
});
export type TidyJob = z.infer<typeof TidyJobSchema>;

export const TidyStreamEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('progress'),
    data: z.object({
      /**
       * Widened to an open string. The trap this retires: a *narrower* type
       * here (an enum over the two values the server emits today) would throw
       * on a third value a future function adds, and `parseTidyStreamEvent`'s
       * `.parse` throwing turns a live, still-applying run (`EdgeRuntime.
       * waitUntil`, §0) into "Tidiness failed — malformed stream data." on any
       * bundle cached before that deploy. The server itself still emits only
       * `'planning'` and `'applying'` — enforced by a narrow helper
       * server-side (`tidy-notes/index.ts`'s `TidyStreamContext.progress`) —
       * until the 2026 stale bundles have aged out; widening here just means a
       * value it *does* send one day parses instead of crashing every browser
       * that hasn't refreshed. See the forward-compat test in index.test.ts.
       */
      stage: z.string(),
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      /**
       * Which of the three planning/apply sub-steps this event reports on:
       * `'taxonomy'`, `'assignments'`, or `'applying'`. Optional and open, following the
       * `error` event's `code` field below in this same union (deliberately
       * not an enum, for the same non-atomic-deploy reason) — an older function never
       * sends it, and a newer one may send a phase this bundle has never heard
       * of. `stage` keeps its old two-value meaning forever: `'taxonomy'` and
       * `'assignments'` both ride `stage: 'planning'`, so a client that has
       * never heard of `phase` still shows the right word, just not the finer
       * one. The client prefers `phase` when it recognizes it and falls back
       * to `stage` otherwise (`tidyProgressLabel`, `apps/web/.../TidyModal.tsx`).
       */
      phase: z.string().optional(),
    }),
  }),
  z.object({
    event: z.literal('done'),
    data: z.object({
      runId: uuid,
      applied: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
  }),
  /** Terminal: the run paused for a human confirm and the stream ends here. */
  z.object({
    event: z.literal('pending_confirm'),
    data: z.object({ runId: uuid, summary: TidyPendingSummarySchema }),
  }),
  z.object({
    event: z.literal('error'),
    /**
     * Deliberately an open string, not an enum over the codes this build knows.
     * Both directions of a non-atomic deploy have to keep the engine's message:
     * an older function omits `code` entirely, and a newer one may send a code
     * this bundle has never heard of. An enum would reject the second and the
     * client would replace a real error with "malformed stream data" — which is
     * exactly the stale-bundle hazard this arc has been careful about. Meaning
     * is assigned at the point of use, by comparing against
     * `TIDY_REFUSED_CODE`; anything else is a plain failure.
     */
    data: z.object({ message: z.string(), code: z.string().optional() }),
  }),
]);
export type TidyStreamEvent = z.infer<typeof TidyStreamEventSchema>;

// parseTidyStreamEvent filters through this set: a name missing here is
// silently dropped, and the client reports "stream ended unexpectedly".
const TIDY_STREAM_EVENT_NAMES = new Set(['progress', 'done', 'pending_confirm', 'error']);

/** Unknown events are forward-compatible; known events remain strictly validated. */
export function parseTidyStreamEvent(event: string, data: unknown): TidyStreamEvent | null {
  if (!TIDY_STREAM_EVENT_NAMES.has(event)) return null;
  return TidyStreamEventSchema.parse({ event, data });
}

/**
 * Mirrors the `recall_usage` table. `month` is a period key, not a month:
 * 'YYYY-MM' is the UTC-calendar-month fallback (no subscription anchor) and
 * 'YYYY-MM-DD' is the start date of a billing-anchored period. Both formats
 * are accepted by the table's check constraint; the column keeps its original
 * name because deployed clients still filter on it.
 */
export const PERIOD_KEY_PATTERN = /^\d{4}-\d{2}(-\d{2})?$/;

export const RecallUsageSchema = z.object({
  user_id: uuid,
  month: z.string().regex(PERIOD_KEY_PATTERN),
  count: z.number().int(),
  semantic_search_count: z.number().int(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type RecallUsage = z.infer<typeof RecallUsageSchema>;

/**
 * The caller's own counters plus the quota window they belong to, as returned
 * by the `current_recall_usage()` RPC. The window is server-resolved: with
 * billing-anchored periods a browser cannot derive the period key, and one
 * that guessed would silently report zero usage.
 */
export const RecallPeriodUsageSchema = z.object({
  period_key: z.string().regex(PERIOD_KEY_PATTERN),
  period_start: timestamptz,
  period_end: timestamptz,
  recall_count: z.number().int(),
  semantic_search_count: z.number().int(),
});
export type RecallPeriodUsage = z.infer<typeof RecallPeriodUsageSchema>;

/**
 * Effective per-period limits returned by the authenticated usage-limits
 * function. `month` is the UTC calendar month the response was built in; it is
 * unrelated to the caller's quota window (which comes from
 * {@link RecallPeriodUsageSchema}) and is retained only for older clients.
 */
export const UsageLimitsSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  recall_monthly_limit: z.number().int().positive(),
  history_search_monthly_limit: z.number().int().positive(),
});
export type UsageLimits = z.infer<typeof UsageLimitsSchema>;

// The recall Edge Function's response shape, shared with the web UI.
export const RecallSourceSchema = z.object({
  id: uuid,
  title: z.string(),
});
export type RecallSource = z.infer<typeof RecallSourceSchema>;

/** One completed Recall row as stored by Postgres, including derived search state. */
export const StoredRecallSchema = z.object({
  id: uuid,
  user_id: uuid,
  query: z.string(),
  answer: z.string(),
  sources: z.array(RecallSourceSchema),
  search_embedding: z.array(z.number()).length(EMBEDDING_DIM).nullable(),
  pinned_at: timestamptz.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type StoredRecall = z.infer<typeof StoredRecallSchema>;

/** Client-visible completed Recall answer; derived vectors never cross this boundary. */
export const RecallSchema = StoredRecallSchema.omit({ search_embedding: true });
export type Recall = z.infer<typeof RecallSchema>;
export const RecallMetaSchema = RecallSchema.omit({ answer: true });
export type RecallMeta = z.infer<typeof RecallMetaSchema>;
export const SemanticRecallMatchSchema = RecallMetaSchema.extend({
  similarity: z.number().min(0).max(1),
});
export type SemanticRecallMatch = z.infer<typeof SemanticRecallMatchSchema>;

export interface RecallListOptions {
  pageSize?: number;
  offset?: number;
  search?: string;
}

export interface RecallListPage {
  items: RecallMeta[];
  total: number;
  hasMore: boolean;
}

export const RecallDoneSchema = z.object({
  recallId: uuid.optional(),
  historySaved: z.boolean().optional(),
});
export type RecallDone = z.infer<typeof RecallDoneSchema>;
export const RecallAnswerSchema = z.object({
  answer: z.string(),
  sources: z.array(RecallSourceSchema),
});
export type RecallAnswer = z.infer<typeof RecallAnswerSchema>;

export const RecallMatchSchema = RecallSourceSchema.extend({
  similarity: z.number().finite(),
});
export type RecallMatch = z.infer<typeof RecallMatchSchema>;

export const RecallStreamEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('matches'),
    data: z.object({
      matches: z.array(RecallMatchSchema),
      total: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    event: z.literal('answer.delta'),
    data: z.object({ text: z.string() }),
  }),
  z.object({
    event: z.literal('sources'),
    data: z.object({ sources: z.array(RecallSourceSchema) }),
  }),
  z.object({
    event: z.literal('done'),
    data: RecallDoneSchema,
  }),
  z.object({
    event: z.literal('error'),
    data: z.object({ message: z.string() }),
  }),
]);
export type RecallStreamEvent = z.infer<typeof RecallStreamEventSchema>;

const RECALL_STREAM_EVENT_NAMES = new Set(['matches', 'answer.delta', 'sources', 'done', 'error']);

/** Unknown events are forward-compatible; known events remain strictly validated. */
export function parseRecallStreamEvent(event: string, data: unknown): RecallStreamEvent | null {
  if (!RECALL_STREAM_EVENT_NAMES.has(event)) return null;
  return RecallStreamEventSchema.parse({ event, data });
}

// The billing-links Edge Function's response shape. Checkouts are only
// minted for users who can use them (null for pro); portal URLs are
// pre-signed and short-lived — fetched on click, never cached.
export const BillingLinksSchema = z.object({
  checkoutUrl: z.string().url().nullable(),
  portalUrl: z.string().url().nullable(),
});
export type BillingLinks = z.infer<typeof BillingLinksSchema>;

// The delete-account Edge Function's 200 body is a closed contract: only this
// exact shape proves the auth user is gone and local recovery state may be
// retired, so adding a field is a breaking change (`.strict()` enforces it —
// clients treat any other 200 as an ambiguous, possibly partial deletion).
export const DeletedAccountResponseSchema = z.object({ deleted: z.literal(true) }).strict();

// Note version history. Every content edit snapshots the note's *previous*
// title/body here (Postgres trigger). Rows are user content — soft-deletable
// and purged on account deletion — but immutable in practice: clients get
// SELECT only, and reads are Pro-gated by RLS. Not sync-pulled; fetched on
// demand, so there is no Dexie table for them.
export const NoteVersionSchema = z.object({
  id: uuid,
  note_id: uuid,
  user_id: uuid,
  title: z.string(),
  body: z.string(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type NoteVersion = z.infer<typeof NoteVersionSchema>;

// History listings never fetch bodies (they can be large and there can be
// many versions): the list shows metadata, and a body is loaded only when a
// version is opened for diffing.
export const NoteVersionMetaSchema = NoteVersionSchema.omit({ body: true });
export type NoteVersionMeta = z.infer<typeof NoteVersionMetaSchema>;

// Join rows carry the full audit column set: the sync cursor pulls each table
// by (user_id, updated_at), and removals are soft-deletes like everywhere else.
export const NoteTagSchema = z.object({
  note_id: uuid,
  tag_id: uuid,
  user_id: uuid,
  sync_seq: syncSeq.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type NoteTag = z.infer<typeof NoteTagSchema>;

/**
 * The same four rows as they come back from Postgres, where the trigger has
 * always set `sync_seq`. Parse server responses with these: the local schemas
 * accept null, so they would wave through a response that lost the column —
 * a column-list select that forgot it, or a future RPC returning a projection
 * — and the pull would then advance its cursor off rows carrying no cursor
 * key at all. Requiring it here turns that into a parse error at the boundary.
 */
export const ServerNoteSchema = NoteSchema.extend({ sync_seq: syncSeq });
export const ServerFolderSchema = FolderSchema.extend({ sync_seq: syncSeq });
export const ServerTagSchema = TagSchema.extend({ sync_seq: syncSeq });
export const ServerNoteTagSchema = NoteTagSchema.extend({ sync_seq: syncSeq });

/**
 * The canonical SQLite schema for the local store, emitted into the desktop
 * crate's migrations (plans/desktop-app.md §4.4). Re-exported here so the
 * column map — the one source for what columns exist — is reachable from the
 * same import as the Zod row schemas it mirrors.
 */
export * from './sqlite-ddl.js';

/**
 * The shared save-note semantics (plans/desktop-app.md §6): pure planning
 * functions that turn "jot this, here, with these tags" into row inserts,
 * ported from `mcp_save_note` and pinned to it by a conformance suite.
 *
 * Deliberately barrel-reachable: the barrel's closure is exactly what the
 * vendoring generator (§4.5) copies into `packages/mcp/src/core`, and WP6's
 * local-library CLI is the reason this module exists. Dependency-free, so it
 * drags nothing into either consumer.
 */
export * from './save-note.js';

// The shared LocalStore fixture format lives in `./local-store-fixtures` and is
// deliberately NOT re-exported here. This barrel is imported by the SPA (via
// local-store.ts, for the column map), so anything exported from it can end up
// in the app bundle — and a test-only Zod schema has no business shipping to a
// browser. Test runners import that module by path.

// One resolver, both surfaces (plans/desktop-app.md §5.4): the CLI commands and
// the MCP server tools choose their target the same way, because a rule that
// holds for `kinjot add` and not for the `jot` tool is a rule that ships jots
// to the wrong place from inside an agent session.

import { NotesApi } from './api.js';
import type {
  AppendNoteInput,
  EditedNote,
  EditNoteInput,
  FullNote,
  RecallMatch,
  SaveNoteInput,
  SavedNote,
  SearchHit,
  SearchResult,
  UploadedImage,
  UploadImageInput,
  InboxNotifyInput,
  InboxNotifyResult,
  InboxMuteState,
  InboxListInput,
  InboxListResult,
  InboxResolveInput,
  InboxResolveResult,
} from './api.js';
import { resolveConfig } from './config.js';
import { openLocalLibrary } from './local/library.js';
import { LocalModeError } from './local/runtime.js';
import { saveNoteLocally } from './local/save-note.js';
import { resolveMode, type ModeResolution } from './mode.js';

/**
 * What both surfaces call. `NotesApi` satisfies it structurally, so the account
 * path is the same object it always was — no wrapper, no behaviour change.
 */
export interface JotBackend {
  uploadImage(input: UploadImageInput): Promise<UploadedImage>;
  inboxMuteState(): Promise<InboxMuteState>;
  inboxNotify(input: InboxNotifyInput): Promise<InboxNotifyResult>;
  inboxList(input: InboxListInput): Promise<InboxListResult>;
  inboxResolve(input: InboxResolveInput): Promise<InboxResolveResult>;
  saveNote(input: SaveNoteInput): Promise<SavedNote>;
  editNote(input: EditNoteInput): Promise<EditedNote>;
  appendNote(input: AppendNoteInput): Promise<EditedNote>;
  searchNotes(query: string): Promise<SearchResult>;
  recallNotes(query: string): Promise<RecallMatch[]>;
  getNote(id: string): Promise<FullNote>;
  listRecentNotes(limit?: number): Promise<SearchHit[]>;
}

/**
 * The four reads are **deliberately not implemented** in local mode (recorded
 * scope decision, WP6 PR C). Search, recall, get and recent all have real
 * answers in the desktop app — MiniSearch, saved Recall history, the note list
 * — and reimplementing any of them against SQLite in the CLI would be a second
 * search stack to keep in step with the app's. So each one names the app.
 */
export class LocalUnavailableError extends LocalModeError {}

function notInLocalMode(what: string): LocalUnavailableError {
  return new LocalUnavailableError(
    `${what} is not available in local mode — open the Kinjot desktop app to browse, search ` +
      `and recall your local library. (\`kinjot add\` writes to it; \`kinjot where\` shows ` +
      `which library that is.)`,
  );
}

/**
 * Writes through the pointer handshake, one open per call.
 *
 * Per call rather than per process because the MCP server is long-lived: a
 * library that was uninstalled, replaced or migrated between two jots must be
 * met by a fresh handshake rather than by a handle taken at startup, and
 * nothing here is hot enough for the open to matter (an agent jots between
 * turns, not between keystrokes).
 */
export class LocalBackend implements JotBackend {
  constructor(private readonly dir: string) {}

  async uploadImage(_input: UploadImageInput): Promise<UploadedImage> {
    throw notInLocalMode('uploading an image');
  }

  async inboxMuteState(): Promise<InboxMuteState> {
    throw inboxLocalError();
  }

  async inboxNotify(_input: InboxNotifyInput): Promise<InboxNotifyResult> {
    throw inboxLocalError();
  }
  async inboxList(_input: InboxListInput): Promise<InboxListResult> {
    throw inboxLocalError();
  }
  async inboxResolve(_input: InboxResolveInput): Promise<InboxResolveResult> {
    throw inboxLocalError();
  }

  async saveNote(input: SaveNoteInput): Promise<SavedNote> {
    const library = openLocalLibrary(this.dir);
    try {
      return saveNoteLocally(library, {
        title: input.title,
        id: input.id,
        body: input.body,
        tags: input.tags,
        folder: input.folder,
        source: input.source ?? 'mcp',
        vocabulary: input.vocabulary,
      });
    } finally {
      library.close();
    }
  }

  async editNote(_input: EditNoteInput): Promise<EditedNote> {
    throw notInLocalMode('editing a note');
  }

  async appendNote(_input: AppendNoteInput): Promise<EditedNote> {
    throw notInLocalMode('appending to a note');
  }

  async searchNotes(): Promise<SearchResult> {
    throw notInLocalMode('search');
  }

  async recallNotes(): Promise<RecallMatch[]> {
    throw notInLocalMode('recall');
  }

  async getNote(): Promise<FullNote> {
    throw notInLocalMode('reading a note by id');
  }

  async listRecentNotes(): Promise<SearchHit[]> {
    throw notInLocalMode('listing recent jots');
  }
}

function inboxLocalError(): LocalUnavailableError {
  return new LocalUnavailableError(
    'The Kinjot Inbox needs a Kinjot account; it is not available for a local library.',
  );
}

/**
 * The serve path's backend: re-resolves the mode on **every tool call**.
 *
 * The MCP server is long-lived and §5.4 is a per-invocation rule, so resolving
 * once at startup gets both failure shapes wrong. `kinjot use` would be frozen
 * until the host restarts the server. And row 4 — armed for every stored-key
 * user the moment they run the desktop app once (PR A) — would become a server
 * that fails to *start*, which is the one place its refusal (whose entire
 * justification is being actionable) cannot reach the agent. Per call, it
 * arrives as a tool error naming `kinjot use account`, and the agent relays it.
 *
 * The account path moves with it: a missing key errors on the first tool call
 * now, instead of at startup — the same sentence, somewhere a person sees it.
 *
 * Per-call resolution opens one seam this closes: the MCP server caches the
 * previous jot's tag vocabulary and passes it into the next, so a mode switch
 * mid-session would normalize a local jot's tags against the *account's*
 * spellings (or vice versa) — account data steering writes into the local
 * library. The vocabulary hint is dropped on the first save and on every edit
 * after a target change until a save re-caches the target's own spellings.
 */
export function serveBackend(
  env: Record<string, string | undefined> = process.env,
  makeApi?: (env: Record<string, string | undefined>) => NotesApi,
): JotBackend {
  const resolve = () => resolveBackend(env, makeApi);
  let lastSaveTarget: string | undefined;
  return {
    uploadImage: (input) => resolve().backend.uploadImage(input),
    inboxMuteState: () => resolve().backend.inboxMuteState(),
    inboxNotify: (input) => resolve().backend.inboxNotify(input),
    inboxList: (input) => resolve().backend.inboxList(input),
    inboxResolve: (input) => resolve().backend.inboxResolve(input),
    saveNote: (input) => {
      const { backend, resolution } = resolve();
      const target = resolution.mode === 'local' ? `local:${resolution.dir}` : 'account';
      const stale = lastSaveTarget !== undefined && lastSaveTarget !== target;
      lastSaveTarget = target;
      return backend.saveNote(stale ? { ...input, vocabulary: undefined } : input);
    },
    editNote: (input) => {
      const { backend, resolution } = resolve();
      const target = resolution.mode === 'local' ? `local:${resolution.dir}` : 'account';
      // Edits return no vocabulary, so only a successful jot can refresh the
      // source of this hint. Keep dropping it on later edits until then.
      const stale = lastSaveTarget !== undefined && lastSaveTarget !== target;
      return backend.editNote(stale ? { ...input, vocabulary: undefined } : input);
    },
    appendNote: (input) => resolve().backend.appendNote(input),
    searchNotes: (query) => resolve().backend.searchNotes(query),
    recallNotes: (query) => resolve().backend.recallNotes(query),
    getNote: (id) => resolve().backend.getNote(id),
    listRecentNotes: (limit) => resolve().backend.listRecentNotes(limit),
  };
}

export interface ResolvedBackend {
  readonly backend: JotBackend;
  readonly resolution: ModeResolution;
}

/**
 * Resolves the mode and builds the backend for it.
 *
 * The account branch is `new NotesApi(resolveConfig(env))` — byte-for-byte what
 * every command did before this PR, including which errors it raises and when.
 */
export function resolveBackend(
  env: Record<string, string | undefined> = process.env,
  makeApi: (env: Record<string, string | undefined>) => NotesApi = (e) =>
    new NotesApi(resolveConfig(e)),
): ResolvedBackend {
  const resolution = resolveMode(env);
  if (resolution.mode === 'local') {
    return { backend: new LocalBackend(resolution.dir), resolution };
  }
  return { backend: makeApi(env), resolution };
}

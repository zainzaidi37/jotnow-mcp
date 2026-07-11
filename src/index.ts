export { ApiError, NotesApi } from './api.js';
export type { FullNote, SaveNoteInput, SearchHit, SearchResult } from './api.js';
export { API_KEY_PATTERN, DEFAULT_API_URL, resolveConfig } from './config.js';
export { buildServer, serveStdio } from './server.js';
export { detectRepoTag, normalizeTags } from './tagging.js';
export { main, VERSION } from './cli.js';

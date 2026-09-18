// One OS process that holds a local library locked (`library.test.ts`, the
// open-time contention tests; plans/local-library-open-busy-timeout.md §3).
//
// A separate process because `openLocalLibrary` is synchronous and sleeps
// inside SQLite's busy handler: nothing on the test's own event loop can
// release a lock while it waits, so the holder has to live outside it. Plain
// `.mjs`, forked like `race-child.mjs`, and it needs no package code — only
// `node:sqlite`.
//
// Two lock shapes, chosen by argv[4]. `exclusive` (the default):
// `locking_mode = EXCLUSIVE` plus an open transaction and one read, which
// keeps every other connection out of a WAL library, including the schema
// load that the opener's very first prepared statement triggers (measured in
// the plan's §1). `write`: a plain `BEGIN IMMEDIATE`, which lets readers open
// and read but makes every other writer wait at its own `BEGIN IMMEDIATE` —
// the shape `saveNoteLocally` meets. The protocol: `held` once the lock is
// taken; then the holder
// releases after `releaseAfterMs` if that is a number, or after a ceiling the
// tests never reach when it is `never` — the parent kills it long before. The
// ceiling exists because an IPC channel alone does not keep a child alive
// (only a `message` listener refs it), and a timer is a bound rather than a
// leak.

import { DatabaseSync } from 'node:sqlite';

const [dbPath, releaseAfter, mode = 'exclusive'] = process.argv.slice(2);

const db = new DatabaseSync(dbPath);
if (mode === 'write') {
  db.exec('BEGIN IMMEDIATE');
} else {
  db.exec('PRAGMA locking_mode = EXCLUSIVE');
  db.exec('BEGIN');
  db.prepare(`SELECT "value" FROM "meta" WHERE "key" = 'workspace_uuid'`).get();
}

process.send({ type: 'held' });

const HOLD_CEILING_MS = 60_000;
const releaseAfterMs = Number(releaseAfter);
setTimeout(
  () => {
    db.close();
    process.exit(0);
  },
  Number.isFinite(releaseAfterMs) ? releaseAfterMs : HOLD_CEILING_MS,
);

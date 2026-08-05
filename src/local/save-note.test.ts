import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planSaveNote } from '../core/index.js';
import { openLocalLibrary, type LocalLibrary } from './library.js';
import { FIXTURE_WORKSPACE, makeLibraryFixture } from './library-fixture.js';
import { applySaveNotePlan, saveNoteLocally } from './save-note.js';

/**
 * The local applier. The *planning* is `planSaveNote`'s, pinned to
 * `mcp_save_note` row-for-row by `supabase/tests/save-note-conformance.test.ts`
 * — what these cases pin is what this package adds: that the plan is applied in
 * order, all-or-nothing, into the library the handshake opened.
 */

const WORKSPACE = FIXTURE_WORKSPACE;

function rows(library: LocalLibrary, table: string): Record<string, unknown>[] {
  // rowid, so insertion order is what is compared (note_tags has no `id`).
  return library.db.prepare(`SELECT * FROM "${table}" ORDER BY "rowid"`).all();
}

describe('saveNoteLocally', () => {
  let dir: string;
  let library: LocalLibrary;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jotnow-save-'));
    makeLibraryFixture(dir);
    library = openLocalLibrary(dir);
  });

  afterEach(() => {
    library.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the note, its folder and its tags, all owned by the library workspace', () => {
    const saved = saveNoteLocally(library, {
      title: 'Kong routing',
      body: 'db reset breaks kong',
      tags: ['Infra', 'infra', 'Connection Pool'],
      folder: 'Notes',
      source: 'cli',
    });

    const notes = rows(library, 'notes');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      id: saved.id,
      user_id: WORKSPACE,
      title: 'Kong routing',
      body: 'db reset breaks kong',
      source: 'cli',
      sync_seq: null,
      deleted_at: null,
    });
    expect(rows(library, 'folders')[0]).toMatchObject({ name: 'Notes', user_id: WORKSPACE });
    expect(notes[0]!.folder_id).toBe(rows(library, 'folders')[0]!.id);

    // Tag hygiene comes from the same choke point the API path uses.
    expect(saved.tags).toEqual(['infra', 'connection-pool']);
    expect(rows(library, 'tags').map((tag) => tag.name)).toEqual(['infra', 'connection-pool']);
    expect(rows(library, 'note_tags')).toHaveLength(2);
    // The vocabulary is read after the apply, so this call's own tags are in it.
    expect(saved.existingTags).toEqual(expect.arrayContaining(['infra', 'connection-pool']));
  });

  it('reuses an existing folder case-insensitively and an existing tag exactly', () => {
    const first = saveNoteLocally(library, { title: 'one', body: '', folder: 'Work', tags: ['auth'] });
    const second = saveNoteLocally(library, { title: 'two', body: '', folder: 'work', tags: ['auth'] });

    expect(rows(library, 'folders')).toHaveLength(1);
    expect(rows(library, 'tags')).toHaveLength(1);
    expect(rows(library, 'notes')).toHaveLength(2);
    expect(first.id).not.toBe(second.id);
    const folderId = rows(library, 'folders')[0]!.id;
    for (const note of rows(library, 'notes')) expect(note.folder_id).toBe(folderId);
  });

  it('rejects the reserved folder name without writing anything', () => {
    expect(() => saveNoteLocally(library, { title: 'x', body: '', folder: ' Trash ' })).toThrow(
      /invalid_folder/,
    );
    expect(rows(library, 'notes')).toHaveLength(0);
    expect(rows(library, 'folders')).toHaveLength(0);
  });

  it('a duplicate tag in one call links once and does not fail (INSERT OR IGNORE)', () => {
    const saved = saveNoteLocally(library, { title: 'x', body: '', tags: ['auth', ' auth '] });
    expect(saved.tags).toEqual(['auth']);
    expect(rows(library, 'note_tags')).toHaveLength(1);
  });
});

describe('applySaveNotePlan', () => {
  let dir: string;
  let library: LocalLibrary;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jotnow-apply-'));
    makeLibraryFixture(dir);
    library = openLocalLibrary(dir);
  });

  afterEach(() => {
    library.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('unwinds the whole plan when an op fails mid-way — the file is untouched', () => {
    // The RPC has no update path: a note id that already exists is a unique
    // violation that rolls back the folder and tag the call had already
    // created. The local applier owes the same, and this is what proves it is
    // transactional rather than incidentally ordered.
    let counter = 0;
    const context = {
      userId: WORKSPACE,
      folders: [],
      tags: [],
      now: '2026-08-05T10:00:00.000Z',
      newId: () => `planned-${++counter}`,
    };
    const noteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    applySaveNotePlan(library.db, planSaveNote(context, { id: noteId, title: 'first', body: '' }).ops);

    const before = {
      notes: rows(library, 'notes'),
      folders: rows(library, 'folders'),
      tags: rows(library, 'tags'),
      note_tags: rows(library, 'note_tags'),
    };

    const retry = planSaveNote(context, {
      id: noteId,
      title: 'second',
      body: '',
      folder: 'Late Folder',
      tags: ['late-tag'],
    });
    // The folder and the tag are planned *before* the note insert that fails.
    expect(retry.ops[0]!.table).toBe('folders');
    expect(() => applySaveNotePlan(library.db, retry.ops)).toThrow();

    expect({
      notes: rows(library, 'notes'),
      folders: rows(library, 'folders'),
      tags: rows(library, 'tags'),
      note_tags: rows(library, 'note_tags'),
    }).toEqual(before);
  });

  it('leaves no transaction open after a rollback, so the next call still writes', () => {
    const context = {
      userId: WORKSPACE,
      folders: [],
      tags: [],
      now: '2026-08-05T10:00:00.000Z',
      newId: () => 'planned-1',
    };
    const noteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    applySaveNotePlan(library.db, planSaveNote(context, { id: noteId, title: 'first', body: '' }).ops);
    expect(() =>
      applySaveNotePlan(library.db, planSaveNote(context, { id: noteId, title: 'again', body: '' }).ops),
    ).toThrow();

    const saved = saveNoteLocally(library, { title: 'after', body: '' });
    expect(rows(library, 'notes').map((note) => note.id)).toEqual([noteId, saved.id]);
  });
});

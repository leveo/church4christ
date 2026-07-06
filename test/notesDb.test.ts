// notesDb (workers project, live D1). Pastoral notes CRUD: add (with body
// validation), newest-first list, soft-delete hiding + idempotence, count. The
// lib does no visibility gating — that is the admin page's job.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { addNote, countNotes, listNotes, NOTE_MAX_LEN, softDeleteNote } from '../src/lib/notesDb';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM person_notes'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  await env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Ana', 'ana@example.com')").run();
});

describe('addNote', () => {
  it('inserts a trimmed note and returns its id', async () => {
    const id = await addNote(env.DB, 1, 'admin@example.com', '  Visited on Sunday.  ');
    expect(id).toBeGreaterThan(0);
    const notes = await listNotes(env.DB, 1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ author_email: 'admin@example.com', body: 'Visited on Sunday.' });
  });

  it('rejects an empty body', async () => {
    await expect(addNote(env.DB, 1, 'admin@example.com', '   ')).rejects.toThrow('note_empty');
  });

  it('rejects a body over the length cap', async () => {
    await expect(addNote(env.DB, 1, 'admin@example.com', 'x'.repeat(NOTE_MAX_LEN + 1))).rejects.toThrow('note_too_long');
    await expect(addNote(env.DB, 1, 'admin@example.com', 'x'.repeat(NOTE_MAX_LEN))).resolves.toBeGreaterThan(0);
  });
});

describe('listNotes / countNotes / softDeleteNote', () => {
  it('lists newest first', async () => {
    await env.DB
      .prepare("INSERT INTO person_notes (person_id, author_email, body, created_at) VALUES (1, 'a@x', 'older', '2026-01-01 00:00:00')")
      .run();
    await env.DB
      .prepare("INSERT INTO person_notes (person_id, author_email, body, created_at) VALUES (1, 'a@x', 'newer', '2026-06-01 00:00:00')")
      .run();
    const notes = await listNotes(env.DB, 1);
    expect(notes.map((n) => n.body)).toEqual(['newer', 'older']);
    expect(await countNotes(env.DB, 1)).toBe(2);
  });

  it('soft-delete hides a note and is idempotent', async () => {
    const id = await addNote(env.DB, 1, 'a@x', 'private note');
    expect(await softDeleteNote(env.DB, id)).toBe(true);
    expect(await listNotes(env.DB, 1)).toHaveLength(0);
    expect(await countNotes(env.DB, 1)).toBe(0);
    expect(await softDeleteNote(env.DB, id)).toBe(false); // already deleted
  });
});

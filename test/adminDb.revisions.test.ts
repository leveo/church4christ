// Revision restore (workers project, live D1). Covers restoreRevision: a bulletin
// round-trip (edit → restore the older version → fields come back AND a new
// revision is appended, so history is never rewritten); an announcement recreated
// under the SAME id after a hard delete (from both the {v:1,input} and the
// {v:1,deleted} snapshot); the not_found guards (missing id / entity mismatch);
// and the date_taken path when a restored snapshot's UNIQUE date is now held by
// another live row.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  saveBulletin,
  getBulletinForEdit,
  saveAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  listRevisions,
  listRecentRevisions,
  getRevision,
  normalizeEntityId,
  restoreRevision,
  type SaveBulletinInput,
  type SaveAnnouncementInput,
  type RevisionRow,
} from '../src/lib/adminDb';

beforeEach(async () => {
  await env.DB.batch(
    ['DELETE FROM revisions', 'DELETE FROM bulletin_announcements', 'DELETE FROM bulletins', 'DELETE FROM announcement_i18n', 'DELETE FROM announcements', 'DELETE FROM service_type_i18n', 'DELETE FROM service_types'].map(
      (s) => env.DB.prepare(s),
    ),
  );
  await env.DB.prepare(`INSERT INTO service_types (id, sort) VALUES (1, 1), (2, 2)`).run();
});

function bInput(overrides: Partial<SaveBulletinInput> = {}): SaveBulletinInput {
  return {
    id: null,
    serviceTypeId: 1,
    bulletinDate: '2026-08-02',
    serviceTimeLabel: null,
    program: [],
    offering: [],
    attendance: [],
    memoryVerse: 'First verse',
    flowers: null,
    status: 'draft',
    publishAt: null,
    announcements: [],
    ...overrides,
  };
}

function aInput(overrides: Partial<SaveAnnouncementInput> = {}): SaveAnnouncementInput {
  return { id: null, titles: { en: 'Camp is open', zh: '营会开始报名' }, url: 'https://church.example/camp', sort: 1, active: true, startsAt: null, endsAt: null, ...overrides };
}

function idOf(r: { ok: boolean }): number {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return (r as { ok: true; id: number }).id;
}
const oldest = (revs: RevisionRow[]): RevisionRow => revs[revs.length - 1];
const inputSnapshot = (revs: RevisionRow[]): RevisionRow => revs.find((r) => 'input' in JSON.parse(r.snapshot_json))!;

describe('restoreRevision — bulletin round-trip', () => {
  it('restores the older field values and appends a new revision (history not rewritten)', async () => {
    const id = idOf(await saveBulletin(env.DB, bInput({ memoryVerse: 'First verse' }), 'ed@example.com'));
    await saveBulletin(env.DB, bInput({ id, memoryVerse: 'Second verse' }), 'ed@example.com');

    // The current row shows the second edit; two revisions on file.
    expect((await getBulletinForEdit(env.DB, id))!.memoryVerse).toBe('Second verse');
    const before = await listRevisions(env.DB, 'bulletin', id);
    expect(before).toHaveLength(2);

    const res = await restoreRevision(env.DB, 'bulletin', oldest(before).id, 'admin@example.com');
    expect(res).toEqual({ ok: true });

    // Fields are back to the first version…
    expect((await getBulletinForEdit(env.DB, id))!.memoryVerse).toBe('First verse');
    // …and the restore wrote a THIRD revision rather than deleting history.
    expect(await listRevisions(env.DB, 'bulletin', id)).toHaveLength(3);
  });

  it('returns date_taken when the restored date now collides with a live row', async () => {
    const id = idOf(await saveBulletin(env.DB, bInput({ bulletinDate: '2026-08-02' }), 'ed'));
    const firstRev = oldest(await listRevisions(env.DB, 'bulletin', id));
    // Move the row off 2026-08-02, then park another live bulletin on that date.
    await saveBulletin(env.DB, bInput({ id, bulletinDate: '2026-08-09' }), 'ed');
    await saveBulletin(env.DB, bInput({ bulletinDate: '2026-08-02' }), 'ed');

    const res = await restoreRevision(env.DB, 'bulletin', firstRev.id, 'admin');
    expect(res).toEqual({ ok: false, error: 'date_taken' });
  });
});

describe('restoreRevision — announcement recreate-under-same-id', () => {
  it('recreates a hard-deleted announcement under its original id from the input snapshot', async () => {
    const { id } = await saveAnnouncement(env.DB, aInput(), 'ed'); // rev1 {v:1,input}
    await deleteAnnouncement(env.DB, id, 'ed'); // rev2 {v:1,deleted}; row + i18n gone
    expect((await listAnnouncements(env.DB)).some((r) => r.id === id)).toBe(false);

    const rev1 = inputSnapshot(await listRevisions(env.DB, 'announcement', id));
    const res = await restoreRevision(env.DB, 'announcement', rev1.id, 'admin');
    expect(res).toEqual({ ok: true });

    const row = (await listAnnouncements(env.DB)).find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ title_en: 'Camp is open', title_zh: '营会开始报名' });
    // rev1 + rev2 + the restore's new revision.
    expect(await listRevisions(env.DB, 'announcement', id)).toHaveLength(3);
  });

  it('also restores from the {v:1,deleted} snapshot (identical content shape)', async () => {
    const { id } = await saveAnnouncement(env.DB, aInput({ titles: { en: 'Retreat' } }), 'ed');
    await deleteAnnouncement(env.DB, id, 'ed');
    const revs = await listRevisions(env.DB, 'announcement', id);
    const deletedRev = revs.find((r) => 'deleted' in JSON.parse(r.snapshot_json))!;

    expect(await restoreRevision(env.DB, 'announcement', deletedRev.id, 'admin')).toEqual({ ok: true });
    expect((await listAnnouncements(env.DB)).find((r) => r.id === id)!.title_en).toBe('Retreat');
  });
});

describe('restoreRevision — guards', () => {
  it('not_found for a missing revision id', async () => {
    expect(await restoreRevision(env.DB, 'bulletin', 999999, 'admin')).toEqual({ ok: false, error: 'not_found' });
  });

  it('not_found when the revision belongs to a different entity', async () => {
    const id = idOf(await saveBulletin(env.DB, bInput(), 'ed'));
    const rev = oldest(await listRevisions(env.DB, 'bulletin', id));
    expect(await restoreRevision(env.DB, 'sermon', rev.id, 'admin')).toEqual({ ok: false, error: 'not_found' });
  });

  it('id_occupied when a rowid-reused live announcement sits at the deleted snapshot’s id — live row untouched', async () => {
    // Delete the HIGHEST-id announcement: SQLite assigns rowids as max(id)+1, so
    // the next insert reuses the freed id — the exact clobber hazard the guard
    // exists for.
    const { id: oldId } = await saveAnnouncement(env.DB, aInput({ titles: { en: 'Old item' } }), 'ed');
    await deleteAnnouncement(env.DB, oldId, 'ed');
    const { id: newId } = await saveAnnouncement(env.DB, aInput({ titles: { en: 'Newer item' } }), 'ed');
    expect(newId).toBe(oldId); // premise: the id really was reused

    const revs = await listRevisions(env.DB, 'announcement', oldId);
    const deletedRev = revs.find((r) => 'deleted' in JSON.parse(r.snapshot_json))!;
    expect(await restoreRevision(env.DB, 'announcement', deletedRev.id, 'admin')).toEqual({ ok: false, error: 'id_occupied' });

    // The newer live row is untouched and no extra revision was appended.
    expect((await listAnnouncements(env.DB)).find((r) => r.id === newId)!.title_en).toBe('Newer item');
    expect((await listRevisions(env.DB, 'announcement', oldId)).length).toBe(revs.length);
  });

  it('bad_snapshot for an unknown snapshot version (only v:1 is restorable)', async () => {
    const id = idOf(await saveBulletin(env.DB, bInput(), 'ed'));
    const r = await env.DB
      .prepare(`INSERT INTO revisions (entity, entity_id, snapshot_json, edited_by) VALUES ('bulletin', ?1, ?2, 'ed')`)
      .bind(id, JSON.stringify({ v: 2, input: { future: 'shape' } }))
      .run();
    const revId = r.meta.last_row_id as number;
    expect(await restoreRevision(env.DB, 'bulletin', revId, 'admin')).toEqual({ ok: false, error: 'bad_snapshot' });
    // The bulletin was not touched by the refused restore.
    expect((await getBulletinForEdit(env.DB, id))!.memoryVerse).toBe('First verse');
  });

  it('bad_snapshot for corrupt snapshot JSON', async () => {
    const id = idOf(await saveBulletin(env.DB, bInput(), 'ed'));
    const r = await env.DB
      .prepare(`INSERT INTO revisions (entity, entity_id, snapshot_json, edited_by) VALUES ('bulletin', ?1, 'not json{{', 'ed')`)
      .bind(id)
      .run();
    expect(await restoreRevision(env.DB, 'bulletin', r.meta.last_row_id as number, 'admin')).toEqual({ ok: false, error: 'bad_snapshot' });
  });
});

describe('revisions entity_id normalization (pg TEXT column parity)', () => {
  // migrations-supabase/0004 widened revisions.entity_id to TEXT (custom_page
  // ids are UUIDs), so postgres.js returns EVERY entity_id as a string there.
  // The readers normalize at the seam: canonical integer ids come back as
  // numbers on both backends; custom_page UUIDs stay strings.
  it('normalizeEntityId: numeric string → number, UUID stays string, number passes through', () => {
    expect(normalizeEntityId('42')).toBe(42);
    expect(normalizeEntityId(42)).toBe(42);
    expect(normalizeEntityId('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe('3fa85f64-5717-4562-b3fc-2c963f66afa6');
  });

  it('getRevision + listRecentRevisions: number ids for integer entities, UUID string for custom_page', async () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const bulletinId = idOf(await saveBulletin(env.DB, bInput(), 'ed'));
    const inserted = await env.DB
      .prepare(`INSERT INTO revisions (entity, entity_id, snapshot_json, edited_by) VALUES ('custom_page', ?1, '{"v":1,"input":{}}', 'ed')`)
      .bind(uuid)
      .run();

    const pageRev = await getRevision(env.DB, inserted.meta.last_row_id as number);
    expect(pageRev!.entity_id).toBe(uuid); // NOT coerced to NaN or a number

    const recent = await listRecentRevisions(env.DB, 10);
    const bulletinRow = recent.find((r) => r.entity === 'bulletin')!;
    expect(bulletinRow.entity_id).toBe(bulletinId);
    expect(typeof bulletinRow.entity_id).toBe('number');
    expect(recent.find((r) => r.entity === 'custom_page')!.entity_id).toBe(uuid);
  });

  it('restoreRevision refuses a non-numeric entity_id as not_found (custom_page is not restorable here)', async () => {
    const inserted = await env.DB
      .prepare(`INSERT INTO revisions (entity, entity_id, snapshot_json, edited_by) VALUES ('custom_page', '3fa85f64-5717-4562-b3fc-2c963f66afa6', '{"v":1,"input":{}}', 'ed')`)
      .run();
    expect(await restoreRevision(env.DB, 'custom_page', inserted.meta.last_row_id as number, 'admin')).toEqual({
      ok: false,
      error: 'not_found',
    });
  });
});

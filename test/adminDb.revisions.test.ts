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
});

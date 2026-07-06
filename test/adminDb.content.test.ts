// Content admin data-access (workers project, live D1). Ports the dcfc-website
// saveBulletin/saveSermon/savePrayerSheet suites, adapted to our schema
// (bulletins/sermons keyed on (service_type_id, date); prayer_sheets on
// sheet_date + a locale column) and to the Result-returning API
// ({ok:true,id} | {ok:false,errors:{<dateField>}}). Covers create + read-back,
// update-overwrites + announcement rewrite, the versioned {v:1,input} revision
// snapshot, the live-date collision → errors.dateTaken, the revive-on-
// soft-deleted-slot (same id kept), draft-vs-public visibility, and soft-delete
// removing a row from both the admin list and the public queries.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  saveBulletin,
  getBulletinForEdit,
  listBulletins,
  softDeleteBulletin,
  saveSermon,
  getSermonForEdit,
  listSermons,
  softDeleteSermon,
  savePrayerSheet,
  getPrayerSheetForEdit,
  listPrayerSheets,
  softDeletePrayerSheet,
  type SaveBulletinInput,
  type SaveSermonInput,
  type SavePrayerSheetInput,
} from '../src/lib/adminDb';
import { latestBulletins, latestPublishedSermon, latestPrayerSheet } from '../src/lib/publicDb';

beforeEach(async () => {
  await env.DB.batch(
    [
      'DELETE FROM revisions',
      'DELETE FROM bulletin_announcements',
      'DELETE FROM bulletins',
      'DELETE FROM sermons',
      'DELETE FROM prayer_sheets',
      'DELETE FROM service_type_i18n',
      'DELETE FROM service_types',
    ].map((s) => env.DB.prepare(s)),
  );
  await env.DB.prepare(`INSERT INTO service_types (id, sort) VALUES (1, 1), (2, 2)`).run();
  await env.DB
    .prepare(
      `INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES
        (1, 'en', 'English Service'), (1, 'zh', '英文堂'), (2, 'en', 'Chinese Service'), (2, 'zh', '中文堂')`,
    )
    .run();
});

function idOf(r: { ok: boolean }): number {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return (r as { ok: true; id: number }).id;
}

// ── Bulletins ────────────────────────────────────────────────────────────────

function bInput(overrides: Partial<SaveBulletinInput> = {}): SaveBulletinInput {
  return {
    id: null,
    serviceTypeId: 1,
    bulletinDate: '2026-07-05',
    serviceTimeLabel: '9:30 AM',
    program: [{ item: 'Prelude', content: '', person: 'Pianist' }],
    offering: [{ label: 'General', amount: '100' }],
    attendance: [{ label: 'Adults', count: '50' }],
    memoryVerse: 'John 3:16',
    flowers: 'Given by the Lin family',
    status: 'draft',
    publishAt: null,
    announcements: [{ title: 'Camp', body: 'Sign up now', linkUrl: null, linkLabel: null }],
    ...overrides,
  };
}

async function annCount(id: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bulletin_announcements WHERE bulletin_id = ?`).bind(id).first<{ n: number }>();
  return row?.n ?? 0;
}

async function revCount(entity: string, entityId: number): Promise<number> {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM revisions WHERE entity = ? AND entity_id = ?`)
    .bind(entity, entityId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('saveBulletin — create', () => {
  it('inserts a bulletin, its announcements, and a revision in one consistent write', async () => {
    const r = await saveBulletin(env.DB, bInput(), 'ed@example.com');
    const id = idOf(r);

    const got = await getBulletinForEdit(env.DB, id);
    expect(got).toMatchObject({ serviceTypeId: 1, bulletinDate: '2026-07-05', serviceTimeLabel: '9:30 AM', status: 'draft', memoryVerse: 'John 3:16' });
    expect(got!.program).toEqual([{ item: 'Prelude', content: '', person: 'Pianist' }]);
    expect(got!.offering).toEqual([{ label: 'General', amount: '100' }]);
    expect(got!.attendance).toEqual([{ label: 'Adults', count: '50' }]);
    expect(got!.announcements).toEqual([{ title: 'Camp', body: 'Sign up now', linkUrl: null, linkLabel: null }]);

    // Full-row consistency: the child + revision rows landed with the bulletin.
    expect(await annCount(id)).toBe(1);
    expect(await revCount('bulletin', id)).toBe(1);
  });

  it('writes a versioned {v:1,input} revision snapshot without the row id', async () => {
    const id = idOf(await saveBulletin(env.DB, bInput(), 'ed@example.com'));
    const rev = await env.DB
      .prepare(`SELECT snapshot_json, edited_by FROM revisions WHERE entity = 'bulletin' AND entity_id = ?`)
      .bind(id)
      .first<{ snapshot_json: string; edited_by: string }>();
    expect(rev!.edited_by).toBe('ed@example.com');
    const snap = JSON.parse(rev!.snapshot_json);
    expect(snap.v).toBe(1);
    expect(snap.input.bulletinDate).toBe('2026-07-05');
    expect(snap.input.announcements).toHaveLength(1);
    expect('id' in snap.input).toBe(false);
  });

  it('allows the same date for a different service type (composite key)', async () => {
    idOf(await saveBulletin(env.DB, bInput({ serviceTypeId: 1 }), 'ed'));
    const r = await saveBulletin(env.DB, bInput({ serviceTypeId: 2 }), 'ed');
    expect(r.ok).toBe(true);
  });

  it('maps a duplicate LIVE (service type, date) to errors.dateTaken', async () => {
    await saveBulletin(env.DB, bInput(), 'ed');
    const r = await saveBulletin(env.DB, bInput({ memoryVerse: 'clash' }), 'ed');
    expect(r).toEqual({ ok: false, errors: { bulletin_date: 'errors.dateTaken' } });
  });
});

describe('saveBulletin — update', () => {
  it('overwrites fields and rewrites announcements (old rows replaced)', async () => {
    const id = idOf(
      await saveBulletin(
        env.DB,
        bInput({
          announcements: [
            { title: 'A', body: 'a', linkUrl: null, linkLabel: null },
            { title: 'B', body: 'b', linkUrl: null, linkLabel: null },
          ],
        }),
        'ed',
      ),
    );
    expect(await annCount(id)).toBe(2);

    await saveBulletin(
      env.DB,
      bInput({ id, memoryVerse: 'updated', announcements: [{ title: 'C', body: 'c', linkUrl: 'https://x.example', linkLabel: 'go' }] }),
      'ed',
    );

    const got = await getBulletinForEdit(env.DB, id);
    expect(got!.memoryVerse).toBe('updated');
    expect(got!.announcements).toEqual([{ title: 'C', body: 'c', linkUrl: 'https://x.example', linkLabel: 'go' }]);
    expect(await annCount(id)).toBe(1);
    // A revision was appended for each save (history preserved).
    expect(await revCount('bulletin', id)).toBe(2);
  });
});

describe('saveBulletin — soft delete + revive', () => {
  it('reclaims a soft-deleted (service type, date) slot under the same id on insert', async () => {
    const first = idOf(await saveBulletin(env.DB, bInput({ memoryVerse: 'first' }), 'ed'));
    await softDeleteBulletin(env.DB, first, 'ed');
    expect(await getBulletinForEdit(env.DB, first)).toBeNull(); // hidden while deleted

    const again = await saveBulletin(env.DB, bInput({ memoryVerse: 'second' }), 'ed');
    expect(again).toEqual({ ok: true, id: first }); // same row reclaimed
    const got = await getBulletinForEdit(env.DB, first);
    expect(got!.memoryVerse).toBe('second');
  });

  it('a draft shows in admin listBulletins but not public latestBulletins; soft-delete removes it from both', async () => {
    const draftId = idOf(await saveBulletin(env.DB, bInput({ status: 'draft' }), 'ed'));
    expect((await listBulletins(env.DB)).some((b) => b.id === draftId)).toBe(true);
    expect((await latestBulletins(env.DB, 'en')).some((b) => b.id === draftId)).toBe(false);

    const pubId = idOf(await saveBulletin(env.DB, bInput({ serviceTypeId: 2, status: 'published', publishAt: null }), 'ed'));
    expect((await latestBulletins(env.DB, 'en')).some((b) => b.id === pubId)).toBe(true);
    expect((await listBulletins(env.DB)).some((b) => b.id === pubId)).toBe(true);

    await softDeleteBulletin(env.DB, pubId, 'ed');
    expect((await latestBulletins(env.DB, 'en')).some((b) => b.id === pubId)).toBe(false);
    expect((await listBulletins(env.DB)).some((b) => b.id === pubId)).toBe(false);
  });

  it('listBulletins filters by service type', async () => {
    idOf(await saveBulletin(env.DB, bInput({ serviceTypeId: 1 }), 'ed'));
    idOf(await saveBulletin(env.DB, bInput({ serviceTypeId: 2 }), 'ed'));
    expect((await listBulletins(env.DB, { serviceTypeId: 2 })).map((b) => b.service_type_id)).toEqual([2]);
  });
});

// ── Sermons ────────────────────────────────────────────────────────────────

function sInput(overrides: Partial<SaveSermonInput> = {}): SaveSermonInput {
  return {
    id: null,
    serviceTypeId: 1,
    sermonDate: '2026-07-05',
    title: 'The Beatitudes',
    speaker: 'Sarah Johnson',
    scripture: 'Matthew 5:1-12',
    youtubeId: 'abcDEF12345',
    series: 'Sermon on the Mount',
    status: 'published',
    ...overrides,
  };
}

describe('saveSermon', () => {
  it('creates, reads back, and writes a versioned revision', async () => {
    const id = idOf(await saveSermon(env.DB, sInput(), 'ed'));
    const got = await getSermonForEdit(env.DB, id);
    expect(got).toMatchObject({ serviceTypeId: 1, sermonDate: '2026-07-05', title: 'The Beatitudes', youtubeId: 'abcDEF12345', status: 'published' });
    const rev = await env.DB.prepare(`SELECT snapshot_json FROM revisions WHERE entity='sermon' AND entity_id=?`).bind(id).first<{ snapshot_json: string }>();
    const snap = JSON.parse(rev!.snapshot_json);
    expect(snap.v).toBe(1);
    expect(snap.input.title).toBe('The Beatitudes');
  });

  it('updates in place and appends a revision', async () => {
    const id = idOf(await saveSermon(env.DB, sInput(), 'ed'));
    await saveSermon(env.DB, sInput({ id, title: 'Renamed' }), 'ed');
    expect((await getSermonForEdit(env.DB, id))!.title).toBe('Renamed');
    expect(await revCount('sermon', id)).toBe(2);
  });

  it('maps a duplicate LIVE (service type, date) to errors.dateTaken but allows another service type', async () => {
    await saveSermon(env.DB, sInput(), 'ed');
    expect(await saveSermon(env.DB, sInput({ title: 'Clash' }), 'ed')).toEqual({ ok: false, errors: { sermon_date: 'errors.dateTaken' } });
    expect((await saveSermon(env.DB, sInput({ serviceTypeId: 2 }), 'ed')).ok).toBe(true);
  });

  it('revives a soft-deleted slot under the same id', async () => {
    const first = idOf(await saveSermon(env.DB, sInput({ title: 'First' }), 'ed'));
    await softDeleteSermon(env.DB, first, 'ed');
    const again = await saveSermon(env.DB, sInput({ title: 'Second' }), 'ed');
    expect(again).toEqual({ ok: true, id: first });
    expect((await getSermonForEdit(env.DB, first))!.title).toBe('Second');
  });

  it('a draft shows in admin listSermons but not public latestPublishedSermon; soft-delete removes a published one from both', async () => {
    const draftId = idOf(await saveSermon(env.DB, sInput({ status: 'draft' }), 'ed'));
    expect((await listSermons(env.DB)).some((s) => s.id === draftId)).toBe(true);
    expect((await latestPublishedSermon(env.DB))?.id).not.toBe(draftId);

    const pubId = idOf(await saveSermon(env.DB, sInput({ serviceTypeId: 2, sermonDate: '2026-07-12', status: 'published' }), 'ed'));
    expect((await latestPublishedSermon(env.DB))?.id).toBe(pubId);
    await softDeleteSermon(env.DB, pubId, 'ed');
    expect((await latestPublishedSermon(env.DB))?.id).not.toBe(pubId);
    expect((await listSermons(env.DB)).some((s) => s.id === pubId)).toBe(false);
  });
});

// ── Prayer sheets ────────────────────────────────────────────────────────────

function pInput(overrides: Partial<SavePrayerSheetInput> = {}): SavePrayerSheetInput {
  return {
    id: null,
    sheetDate: '2026-07-01',
    locale: 'zh',
    sections: [{ heading: '感恩', items: ['为主日崇拜感恩', '为同工感恩'] }],
    status: 'published',
    publishAt: null,
    ...overrides,
  };
}

describe('savePrayerSheet', () => {
  it('creates, reads back (incl. locale + sections), and writes a versioned revision', async () => {
    const id = idOf(await savePrayerSheet(env.DB, pInput(), 'ed'));
    const got = await getPrayerSheetForEdit(env.DB, id);
    expect(got).toMatchObject({ sheetDate: '2026-07-01', locale: 'zh', status: 'published' });
    expect(got!.sections).toEqual([{ heading: '感恩', items: ['为主日崇拜感恩', '为同工感恩'] }]);
    const rev = await env.DB.prepare(`SELECT snapshot_json FROM revisions WHERE entity='prayer_sheet' AND entity_id=?`).bind(id).first<{ snapshot_json: string }>();
    expect(JSON.parse(rev!.snapshot_json).v).toBe(1);
  });

  it('maps a duplicate LIVE sheet_date to errors.dateTaken (single-column unique)', async () => {
    await savePrayerSheet(env.DB, pInput(), 'ed');
    expect(await savePrayerSheet(env.DB, pInput({ locale: 'en' }), 'ed')).toEqual({ ok: false, errors: { sheet_date: 'errors.dateTaken' } });
  });

  it('revives a soft-deleted date under the same id', async () => {
    const first = idOf(await savePrayerSheet(env.DB, pInput({ locale: 'zh' }), 'ed'));
    await softDeletePrayerSheet(env.DB, first, 'ed');
    const again = await savePrayerSheet(env.DB, pInput({ locale: 'en' }), 'ed');
    expect(again).toEqual({ ok: true, id: first });
    expect((await getPrayerSheetForEdit(env.DB, first))!.locale).toBe('en');
  });

  it('a draft shows in admin listPrayerSheets but not public latestPrayerSheet; soft-delete removes a published one from both', async () => {
    const draftId = idOf(await savePrayerSheet(env.DB, pInput({ sheetDate: '2026-07-01', status: 'draft' }), 'ed'));
    expect((await listPrayerSheets(env.DB)).some((p) => p.id === draftId)).toBe(true);
    expect((await latestPrayerSheet(env.DB))?.id).not.toBe(draftId);

    const pubId = idOf(await savePrayerSheet(env.DB, pInput({ sheetDate: '2026-07-08', status: 'published' }), 'ed'));
    expect((await latestPrayerSheet(env.DB))?.id).toBe(pubId);
    await softDeletePrayerSheet(env.DB, pubId, 'ed');
    expect((await latestPrayerSheet(env.DB))?.id).not.toBe(pubId);
    expect((await listPrayerSheets(env.DB)).some((p) => p.id === pubId)).toBe(false);
  });
});

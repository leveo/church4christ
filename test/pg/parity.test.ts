import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { getSetting, setSetting, getSettings, setSettings } from '../../src/lib/settings';
import { createLoginToken, consumeToken } from '../../src/lib/auth';
import { listMinistries, getPersonByEmail } from '../../src/lib/db';
import { listHouseholds, linkPersonToHousehold, getHousehold } from '../../src/lib/householdDb';
import { listPeople, saveEvent } from '../../src/lib/adminDb';
import { getNeedsAttention } from '../../src/lib/adminOverviewDb';
import type { SessionUser } from '../../src/lib/types';
import { listPlans } from '../../src/lib/planDb';
import { listActiveEvents } from '../../src/lib/publicDb';
import { getEnabledModules, clearModuleCache } from '../../src/lib/modules';
import { addNote, listNotes } from '../../src/lib/notesDb';

// Cross-backend parity: every core *Db module runs unchanged against Postgres.
// The suite migrates + seeds a real PG database the way an operator would (the
// Task 6 runner pattern), constructs a PgAdapter over it, and exercises at least
// one read AND one write path per module — asserting on the real seeded rows.
// Any failure here is a portability bug to fix in the *source* (portably), never
// in the test. Self-skips (like every pg suite) when DATABASE_URL is unset.
describe.skipIf(!hasPg)('cross-backend parity (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  const run = (script: string) =>
    execFileSync('node', [`scripts/db/${script}`], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    run('migrate-supabase.mjs');
    run('seed-supabase.mjs');
    db = new PgAdapter(sql);
    clearModuleCache();
  });
  afterAll(async () => {
    await sql?.end();
  });

  // ── settings ──────────────────────────────────────────────────────────────
  describe('settings', () => {
    it('reads a seeded localized value', async () => {
      expect(await getSetting(db, 'site.name.en')).toBe('Church4Christ');
      expect(await getSetting(db, 'site.name.zh')).toBe('四方基督教会');
      expect(await getSetting(db, 'missing.key', 'fb')).toBe('fb');
    });
    it('setSetting round-trips and the ON CONFLICT upsert overwrites', async () => {
      await setSetting(db, 'parity.single', 'v1');
      expect(await getSetting(db, 'parity.single')).toBe('v1');
      await setSetting(db, 'parity.single', 'v2');
      expect(await getSetting(db, 'parity.single')).toBe('v2');
    });
    it('setSettings writes several in one batch', async () => {
      await setSettings(db, { 'parity.a': '1', 'parity.b': '2' });
      const got = await getSettings(db, ['parity.a', 'parity.b']);
      expect(got).toEqual({ 'parity.a': '1', 'parity.b': '2' });
    });
  });

  // ── auth (datetime('now', ?) modifiers) ─────────────────────────────────────
  describe('auth tokens', () => {
    it('createLoginToken issues a token that consumeToken atomically redeems once', async () => {
      const issued = await createLoginToken(db, 1);
      expect('raw' in issued).toBe(true);
      const raw = (issued as { raw: string }).raw;

      const first = await consumeToken(db, raw, 'login');
      expect(first).toEqual({ person_id: 1, assignment_id: null });
      // Second consume must fail — used_at is now set (the WHERE clause is the guard).
      expect(await consumeToken(db, raw, 'login')).toBeNull();
    });
  });

  // ── db.ts: i18nJoin-backed ministries index ────────────────────────────────
  describe('ministries index (i18nJoin)', () => {
    it('lists active ministries localized, with team/open-signup rollups', async () => {
      const en = await listMinistries(db, 'en');
      expect(en).toHaveLength(10);
      const worship = en[0];
      expect(worship.slug).toBe('worship');
      expect(worship.name).toBe('Worship');
      expect(worship.teamCount).toBe(1);
      // Plan 1 (date('now','weekday 0')) is always today-or-future, so its one
      // open-signup worship position always counts.
      expect(worship.openSignupSlots).toBe(1);
      expect(en.find((m) => m.slug === 'children')?.teamCount).toBe(0);
    });
    it('falls back through the locale join to zh', async () => {
      const zh = await listMinistries(db, 'zh');
      expect(zh[0].name).toBe('敬拜');
    });
    it('getPersonByEmail finds a seeded person (lowercased)', async () => {
      const p = await getPersonByEmail(db, 'ADMIN@example.com');
      expect(p?.id).toBe(1);
      expect(p?.role).toBe('admin');
    });
  });

  // ── householdDb: rollup read + link write ──────────────────────────────────
  describe('households', () => {
    it('listHouseholds rolls up member_count and filters by name (LOWER LIKE)', async () => {
      const all = await listHouseholds(db);
      expect(all).toHaveLength(3);
      const chen = all.find((h) => h.name.startsWith('Chen Family'));
      expect(chen?.member_count).toBe(3); // David + Amy + dependent Ethan

      const filtered = await listHouseholds(db, { q: 'lin' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toContain('Lin');
    });
    it('linkPersonToHousehold adds a real member (RETURNING id)', async () => {
      // Person 5 (Mark) and household 3 (Zhao) are both unlinked in the seed.
      const memberId = await linkPersonToHousehold(db, 3, 5);
      expect(typeof memberId).toBe('number');
      const h = await getHousehold(db, 3);
      expect(h?.members).toHaveLength(2);
      expect(h?.members.some((m) => m.person_id === 5)).toBe(true);
    });
  });

  // ── adminDb: people search (LOWER LIKE) + saveEvent (RETURNING + batch) ─────
  describe('adminDb people + events', () => {
    it('listPeople returns all seeded people and searches case-insensitively', async () => {
      expect(await listPeople(db)).toHaveLength(10);
      const chen = await listPeople(db, { q: 'CHEN' });
      expect(chen.map((p) => p.email).sort()).toEqual([
        'amy.chen@example.com',
        'pastor.david@example.com',
      ]);
      // The LIKE-wildcard escape: a literal '%' matches itself, nothing here.
      expect(await listPeople(db, { q: '%' })).toHaveLength(0);
    });
    it('listPeople filters by membership_status and household presence', async () => {
      const members = await listPeople(db, { status: 'member' });
      expect(members.every((p) => p.membership_status === 'member')).toBe(true);
      expect(members.length).toBeGreaterThan(0);
      const withHousehold = await listPeople(db, { household: true });
      expect(withHousehold.every((p) => p.household_name !== null)).toBe(true);
    });
    it('saveEvent inserts parent + i18n children + a revision in one transaction', async () => {
      const before = (await sql.unsafe('SELECT count(*)::int AS c FROM revisions'))[0].c as number;
      const res = await saveEvent(
        db,
        {
          id: null,
          titles: { en: 'Parity Event', zh: '平行事件' },
          blurbs: { en: 'EN blurb', zh: '中文简介' },
          imageKey: null,
          url: null,
          sort: 99,
          active: false, // keep it out of the public window so other tests are unaffected
          startsAt: null,
          endsAt: null,
        },
        'admin@example.com',
      );
      expect(typeof res.id).toBe('number');
      const i18n = await sql.unsafe('SELECT locale FROM event_i18n WHERE event_id = $1 ORDER BY locale', [res.id]);
      expect(i18n.map((r) => r.locale)).toEqual(['en', 'zh']);
      const after = (await sql.unsafe('SELECT count(*)::int AS c FROM revisions'))[0].c as number;
      expect(after).toBe(before + 1);
    });
  });

  // ── adminOverviewDb: the shortfall / HAVING-rewrite / GROUP BY query ────────
  describe('needs-attention (Postgres shortfall query)', () => {
    const adminUser: SessionUser = {
      id: 1, email: 'admin@example.com', displayName: 'Admin', role: 'admin',
      isAdmin: true, isEditor: true, memberTeamIds: [], leaderTeamIds: [], lang: 'en',
    };

    it('admin scope reports the seeded pending app + testimony and the exact per-plan shortfalls', async () => {
      // Plans 1 (English service) and 9 (Chinese service) both land on the first
      // upcoming Sunday (seed: date('now','weekday 0')). Scoping the window to that
      // one day makes the grouped shortfall query return exactly those two plans.
      const anchor = (await db.prepare("SELECT date('now','weekday 0') AS d").first<{ d: string }>())!.d;
      const items = await getNeedsAttention(db, 'admin', adminUser, anchor, anchor, 'en');
      const byKind = (k: string) => items.filter((i) => i.kind === k);

      // One pending team application (person 9 → Worship), one pending testimony (#4).
      expect(byKind('apps')).toHaveLength(1);
      expect(byKind('apps')[0].en).toContain('1 new serving applications');
      expect(byKind('testimonies')).toHaveLength(1);
      expect(byKind('testimonies')[0].en).toContain('1 testimonies');
      // The seed never sets notified_at, so nothing is "stale".
      expect(byKind('stale')).toHaveLength(0);

      // Shortfall math per plan (needed − non-declined assignments, floored at 0,
      // summed): plan 1 → pos2 short 1 + pos8 short 2 = 3; plan 9 → pos6 short 1.
      const understaffed = byKind('understaffed');
      expect(understaffed).toHaveLength(2);
      const gapByHref = Object.fromEntries(
        understaffed.map((i) => [i.href, Number(/needs (\d+) role/.exec(i.en)![1])]),
      );
      expect(gapByHref['/en/serve/plans/1']).toBe(3);
      expect(gapByHref['/en/serve/plans/9']).toBe(1);
      // Service name resolved through the localized i18nJoin.
      expect(understaffed.find((i) => i.href === '/en/serve/plans/1')!.en).toContain('Sunday Worship (English)');
    });
  });

  // ── planDb: one read ───────────────────────────────────────────────────────
  describe('planDb', () => {
    it('listPlans returns the seeded future plans with localized service names', async () => {
      const plans = await listPlans(db, null, 'en');
      expect(plans.length).toBeGreaterThanOrEqual(16);
      const names = new Set(plans.map((p) => p.service_type_name));
      expect(names.has('Sunday Worship (English)')).toBe(true);
      expect(names.has('Chinese Sunday Worship')).toBe(true);
    });
  });

  // ── publicDb: listActiveEvents ─────────────────────────────────────────────
  describe('publicDb', () => {
    it('listActiveEvents applies the visibility window + i18n fallback', async () => {
      const today = (await db.prepare("SELECT date('now','start of day') AS d").first<{ d: string }>())!.d;
      const events = await listActiveEvents(db, 'en', today);
      const titles = events.map((e) => e.title);
      expect(titles).toContain('Summer Bible Camp'); // event 1, active, window straddles today
      expect(titles).toContain('Baptism Sunday'); // event 2
      expect(titles).not.toContain('Easter Celebration'); // event 3, inactive + expired
      const camp = events.find((e) => e.title === 'Summer Bible Camp');
      expect(camp?.blurb).toContain('joyful week');
      // imageKey is a quoted (case-preserved) alias — must be null, not undefined.
      expect(camp?.imageKey).toBeNull();
    });
  });

  // ── modules: getEnabledModules with the supabase backend ────────────────────
  describe('modules', () => {
    it("enables all 13 modules on 'supabase' (giving + registration present)", async () => {
      clearModuleCache();
      const enabled = await getEnabledModules(db, 'supabase');
      expect(enabled.size).toBe(13);
      expect(enabled.has('giving')).toBe(true);
      expect(enabled.has('registration')).toBe(true);
    });
    it("backend gate drops giving/registration on 'd1'", async () => {
      clearModuleCache();
      const enabled = await getEnabledModules(db, 'd1');
      expect(enabled.size).toBe(11);
      expect(enabled.has('giving')).toBe(false);
      expect(enabled.has('registration')).toBe(false);
    });
  });

  // ── notesDb: create + list ─────────────────────────────────────────────────
  describe('notesDb', () => {
    it('addNote inserts (RETURNING id) and listNotes reads newest-first', async () => {
      const seeded = await listNotes(db, 2); // person 2 has one seeded note
      expect(seeded).toHaveLength(1);
      const noteId = await addNote(db, 2, 'admin@example.com', 'Parity follow-up note');
      expect(typeof noteId).toBe('number');
      const after = await listNotes(db, 2);
      expect(after).toHaveLength(2);
      expect(after[0].body).toBe('Parity follow-up note'); // newest first
    });
  });
});

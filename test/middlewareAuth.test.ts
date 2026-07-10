// SessionUser loading tests (workers project, live D1). Covers currentUser.ts:
// loadSessionUser rejects epoch mismatch / inactive / soft-deleted and maps role
// flags + team ids (excluding soft-deleted teams); loadSessionUserByEmail (the
// dev-bypass path) ignores epoch but still requires active + non-deleted. A few
// integration cases feed a loaded user through classifyRoute + canAccess. The
// full HTTP-level auth flow (real cookies through the middleware) lands in Task 3.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadSessionUser, loadSessionUserByEmail } from '../src/lib/currentUser';
import { canAccess, classifyRoute } from '../src/lib/routePolicy';

// Storage is isolated per test file but not per test, so reset the FK chain and
// re-seed before each test. Person 3 leads team 1, is a plain member of team 2,
// and belongs to soft-deleted team 3 (which must be excluded from both arrays).
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM team_members'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  await env.DB.prepare(
    `INSERT INTO people (id, display_name, email, role, active, session_epoch, lang, deleted_at) VALUES
      (1, 'Admin',    'admin@example.com',    'admin',  1, 0, 'en', NULL),
      (2, 'Editor',   'editor@example.com',   'editor', 1, 2, 'zh', NULL),
      (3, 'Leader',   'leader@example.com',   'member', 1, 0, NULL, NULL),
      (4, 'Member',   'member@example.com',   'member', 1, 0, 'en', NULL),
      (5, 'Inactive', 'inactive@example.com', 'member', 0, 0, NULL, NULL),
      (6, 'Deleted',  'deleted@example.com',  'member', 1, 0, NULL, datetime('now'))`,
  ).run();
  await env.DB.prepare('INSERT INTO teams (id, ministry_id) VALUES (1, NULL), (2, NULL), (3, NULL)').run();
  await env.DB.prepare("UPDATE teams SET deleted_at = datetime('now') WHERE id = 3").run();
  await env.DB.prepare(
    `INSERT INTO team_members (team_id, person_id, is_leader) VALUES
      (1, 3, 1),
      (2, 3, 0),
      (3, 3, 0)`,
  ).run();
});

describe('loadSessionUser', () => {
  it('loads an active person on a matching epoch, mapping role flags + lang', async () => {
    expect(await loadSessionUser(env.DB, 2, 2)).toEqual({
      id: 2,
      email: 'editor@example.com',
      displayName: 'Editor',
      role: 'editor',
      isAdmin: false,
      isEditor: true,
      isSuperAdmin: false,
      adminAreas: [],
      finance: 0,
      memberTeamIds: [],
      leaderTeamIds: [],
      lang: 'zh',
    });
  });

  it('returns null when the epoch does not match (session revoked by signout)', async () => {
    expect(await loadSessionUser(env.DB, 2, 1)).toBeNull(); // person 2 is at epoch 2
    expect(await loadSessionUser(env.DB, 2, 2)).not.toBeNull();
  });

  it('returns null for inactive, soft-deleted, and unknown people', async () => {
    expect(await loadSessionUser(env.DB, 5, 0)).toBeNull(); // inactive
    expect(await loadSessionUser(env.DB, 6, 0)).toBeNull(); // soft-deleted
    expect(await loadSessionUser(env.DB, 999, 0)).toBeNull(); // missing
  });

  it('collects member ∪ leader team ids, excluding soft-deleted teams', async () => {
    const u = await loadSessionUser(env.DB, 3, 0);
    expect(u).not.toBeNull();
    expect([...u!.memberTeamIds].sort((a, b) => a - b)).toEqual([1, 2]); // team 3 excluded
    expect(u!.leaderTeamIds).toEqual([1]);
  });

  it('maps admin role to isAdmin (and null lang stays null)', async () => {
    const u = await loadSessionUser(env.DB, 1, 0);
    expect(u).toMatchObject({ role: 'admin', isAdmin: true, isEditor: false, lang: 'en' });
    const leader = await loadSessionUser(env.DB, 3, 0);
    expect(leader).toMatchObject({ role: 'member', isAdmin: false, isEditor: false, lang: null });
  });

  it('loads super_admin and validated admin_areas onto the session user', async () => {
    await env.DB.prepare(
      `INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
       VALUES (60, 'S', 'A', 'S A', 'sup@example.com', 'admin', 1, ''),
              (61, 'L', 'A', 'L A', 'lim@example.com', 'admin', 0, 'groups,junk,settings,events'),
              (62, 'E', 'D', 'E D', 'ed@example.com', 'editor', 1, 'groups')`,
    ).run();
    const sup = await loadSessionUser(env.DB, 60, 0);
    expect(sup?.isSuperAdmin).toBe(true);
    const lim = await loadSessionUser(env.DB, 61, 0);
    expect(lim?.isSuperAdmin).toBe(false);
    expect(lim?.adminAreas).toEqual(['groups', 'events']); // junk + reserved filtered
    // the flags are inert on a non-admin row
    const ed = await loadSessionUser(env.DB, 62, 0);
    expect(ed?.isSuperAdmin).toBe(false);
    expect(ed?.adminAreas).toEqual([]);
  });
});

describe('loadSessionUserByEmail (dev bypass)', () => {
  it('loads an active person by email (case-insensitive), ignoring epoch', async () => {
    const u = await loadSessionUserByEmail(env.DB, '  LEADER@Example.com ');
    expect(u).toMatchObject({ id: 3, email: 'leader@example.com', leaderTeamIds: [1] });
  });

  it('returns null for inactive, soft-deleted, and unknown emails', async () => {
    expect(await loadSessionUserByEmail(env.DB, 'inactive@example.com')).toBeNull();
    expect(await loadSessionUserByEmail(env.DB, 'deleted@example.com')).toBeNull();
    expect(await loadSessionUserByEmail(env.DB, 'nobody@example.com')).toBeNull();
  });
});

describe('policy gate over a loaded user', () => {
  it('a team leader clears team + console but not admin-only', async () => {
    const leader = await loadSessionUser(env.DB, 3, 0);
    expect(canAccess(classifyRoute('/serve/plans/7'), leader)).toBe(true);
    expect(canAccess(classifyRoute('/admin'), leader)).toBe(true);
    expect(canAccess(classifyRoute('/admin/people'), leader)).toBe(false);
  });

  it('a plain member reaches personal pages but is blocked from team + console', async () => {
    const member = await loadSessionUser(env.DB, 4, 0);
    expect(canAccess(classifyRoute('/my'), member)).toBe(true);
    expect(canAccess(classifyRoute('/serve/plans'), member)).toBe(false);
    expect(canAccess(classifyRoute('/admin'), member)).toBe(false);
  });

  it('an editor clears console but not team scheduling or admin-only', async () => {
    const editor = await loadSessionUser(env.DB, 2, 2);
    expect(canAccess(classifyRoute('/admin/bulletins'), editor)).toBe(true);
    expect(canAccess(classifyRoute('/serve/plans'), editor)).toBe(false);
    expect(canAccess(classifyRoute('/admin/people'), editor)).toBe(false);
  });

  it('an admin clears every class', async () => {
    const admin = await loadSessionUser(env.DB, 1, 0);
    for (const p of ['/my', '/serve/plans', '/admin', '/admin/people', '/profile/9']) {
      expect(canAccess(classifyRoute(p), admin)).toBe(true);
    }
  });
});

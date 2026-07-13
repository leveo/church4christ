// Pure route-policy tests (node project): the classification table for every
// access class plus the tricky boundaries (`/serve` public vs `/serve/plans`
// team; `/profile` authed vs `/profile/7` team; `/admin` console vs
// `/admin/people` admin-only), the namespace-scoped unknown-path fallbacks
// (protected namespaces fail closed, everything else falls open to the 404),
// and canAccess for each class against anon / member / leader / editor / admin.
import { describe, expect, it } from 'vitest';
import { canAccess, classifyRoute, type RouteClass } from '../src/lib/routePolicy';
import type { SessionUser } from '../src/lib/types';

describe('classifyRoute', () => {
  const cases: [string, RouteClass][] = [
    // ── public ──
    ['/', 'public'],
    ['/visit', 'public'],
    ['/about', 'public'],
    ['/about/staff', 'public'],
    ['/articles', 'public'],
    ['/articles/2026/grace', 'public'],
    ['/fellowships', 'public'],
    ['/ministries', 'public'],
    ['/ministries/5', 'public'],
    ['/events', 'public'],
    ['/sermons', 'public'],
    ['/sermons/2026-06-28', 'public'],
    ['/bulletin', 'public'],
    ['/bulletins', 'public'],
    ['/bulletins/2026-06-28', 'public'],
    ['/prayer', 'public'],
    ['/give', 'public'],
    ['/privacy', 'public'],
    ['/serve', 'public'],
    ['/serve/gifts', 'public'],
    ['/serve/apply', 'public'],
    ['/serve/opportunities', 'public'],
    ['/serve/testimonies', 'public'],
    ['/signin', 'public'],
    ['/auth/abc123', 'public'],
    ['/respond/tok', 'public'],
    ['/email-change/tok123', 'public'],
    ['/cal/feed.ics', 'public'],
    ['/media/covers/x.jpg', 'public'],
    ['/api/prayer-request', 'public'],
    ['/healthz', 'public'],
    ['/404', 'public'],
    // ── giving/registration public surfaces (T4) ──
    ['/give/thanks', 'public'],
    ['/give/checkout', 'public'],
    ['/api/giving/checkout', 'public'],
    ['/api/giving/portal', 'public'],
    ['/api/stripe/webhook', 'public'],
    ['/register', 'public'],
    ['/register/thanks', 'public'],
    ['/api/register/submit', 'public'],
    // ── children's check-in kiosk (T4): token-gated, not session-gated ──
    ['/kiosk', 'public'],
    ['/kiosk/abc123def456', 'public'],
    // ── admin-authored custom pages (T4): no explicit rule, falls through the
    // "everything else is public" default so the route itself enforces
    // published/preview visibility and 404s.
    ['/p/anything', 'public'],
    ['/p/about', 'public'],
    // ── finance (giving admin) ──
    ['/admin/giving', 'finance'],
    ['/admin/giving/funds', 'finance'],
    ['/admin/stripe-events', 'finance'],
    // ── authed ──
    ['/my', 'authed'],
    ['/my/blockouts', 'authed'],
    ['/profile', 'authed'],
    ['/settings/language', 'authed'],
    ['/settings/notifications', 'authed'],
    // ── team ──
    ['/serve/plans', 'team'],
    ['/serve/plans/7', 'team'],
    ['/serve/matrix', 'team'],
    ['/serve/matrix/3', 'team'],
    ['/serve/teams', 'team'],
    ['/profile/7', 'team'],
    // ── console ──
    ['/admin', 'console'],
    ['/admin/bulletins', 'console'],
    ['/admin/sermons/5', 'console'],
    ['/admin/prayer-sheets', 'console'],
    ['/admin/announcements', 'console'],
    ['/admin/events', 'console'],
    ['/admin/pages', 'console'],
    ['/admin/prayer-wall', 'console'],
    ['/admin/revisions', 'console'],
    ['/admin/ministries', 'console'],
    ['/admin/fellowships', 'console'],
    ['/admin/availability', 'console'],
    ['/admin/applications', 'console'],
    ['/admin/testimonies', 'console'],
    ['/admin/registration', 'console'],
    ['/admin/registration/5', 'console'],
    ['/admin/registration/5/export.csv', 'console'],
    // ── adminOnly ──
    ['/admin/people', 'adminOnly'],
    ['/admin/people/4', 'adminOnly'],
    ['/admin/service-types', 'adminOnly'],
    ['/admin/settings', 'adminOnly'],
    ['/admin/reports', 'adminOnly'],
    ['/admin/teams', 'adminOnly'],
    ['/admin/navigation', 'adminOnly'],
    ['/admin/children', 'adminOnly'],
    ['/admin/children/kiosk', 'adminOnly'],
    // ── unknown paths: namespace-scoped fail-closed hybrid ──
    // Protected namespaces fail closed at their tier…
    ['/admin/xyz', 'adminOnly'],
    ['/my/xyz', 'authed'],
    ['/settings/xyz', 'authed'],
    ['/serve/xyz', 'team'],
    ['/profile/xyz', 'team'], // explicit /profile/<id> rule, not the fallback
    // …everything else fails open so anon typo URLs reach the natural 404.
    ['/xyz', 'public'],
    ['/totally-unknown', 'public'],
  ];

  for (const [path, expected] of cases) {
    it(`${path} → ${expected}`, () => {
      expect(classifyRoute(path)).toBe(expected);
    });
  }

  it('normalizes a trailing slash', () => {
    expect(classifyRoute('/serve/')).toBe('public');
    expect(classifyRoute('/serve/plans/')).toBe('team');
    expect(classifyRoute('/admin/')).toBe('console');
    expect(classifyRoute('/profile/')).toBe('authed');
  });

  it('the /serve boundary: exact + gifts/apply/testimonies public, plans/matrix/teams team', () => {
    expect(classifyRoute('/serve')).toBe('public');
    expect(classifyRoute('/serve/gifts')).toBe('public');
    expect(classifyRoute('/serve/plans')).toBe('team');
  });

  it('the /profile boundary: own profile authed, someone else team', () => {
    expect(classifyRoute('/profile')).toBe('authed');
    expect(classifyRoute('/profile/7')).toBe('team');
  });

  it('the /admin boundary: console root vs admin-only people', () => {
    expect(classifyRoute('/admin')).toBe('console');
    expect(classifyRoute('/admin/people')).toBe('adminOnly');
    // an unlisted /admin sub-path fails closed to the strictest tier
    expect(classifyRoute('/admin/whatever')).toBe('adminOnly');
  });

  it('namespace fallbacks are segment-aware: lookalike prefixes stay public', () => {
    expect(classifyRoute('/mystery')).toBe('public'); // not /my
    expect(classifyRoute('/serveware')).toBe('public'); // not /serve
    expect(classifyRoute('/administrator')).toBe('public'); // not /admin
    expect(classifyRoute('/settingsx')).toBe('public'); // not /settings
  });
});

function makeUser(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 1,
    email: 'x@example.com',
    displayName: 'X',
    role: 'member',
    isAdmin: false,
    isEditor: false,
    memberTeamIds: [],
    leaderTeamIds: [],
    lang: null,
    finance: 0,
    ...over,
  };
}

describe('canAccess', () => {
  const anon = null;
  const member = makeUser();
  const teamMember = makeUser({ memberTeamIds: [3] });
  const leader = makeUser({ memberTeamIds: [3], leaderTeamIds: [3] });
  const editor = makeUser({ role: 'editor', isEditor: true });
  const admin = makeUser({ role: 'admin', isAdmin: true });
  const financeUser = makeUser({ finance: 1 });

  it('public: everyone, including anonymous', () => {
    for (const u of [anon, member, editor, admin]) expect(canAccess('public', u)).toBe(true);
  });

  it('authed: any signed-in user, never anonymous', () => {
    expect(canAccess('authed', anon)).toBe(false);
    expect(canAccess('authed', member)).toBe(true);
  });

  it('team: admin or any team membership/leadership; not a teamless member/editor', () => {
    expect(canAccess('team', anon)).toBe(false);
    expect(canAccess('team', member)).toBe(false);
    expect(canAccess('team', editor)).toBe(false);
    expect(canAccess('team', teamMember)).toBe(true);
    expect(canAccess('team', leader)).toBe(true);
    expect(canAccess('team', admin)).toBe(true);
  });

  it('console: editor, admin, or leader; not a plain member (even on a team)', () => {
    expect(canAccess('console', anon)).toBe(false);
    expect(canAccess('console', member)).toBe(false);
    expect(canAccess('console', teamMember)).toBe(false);
    expect(canAccess('console', leader)).toBe(true);
    expect(canAccess('console', editor)).toBe(true);
    expect(canAccess('console', admin)).toBe(true);
  });

  it('adminOnly: admin only', () => {
    expect(canAccess('adminOnly', anon)).toBe(false);
    expect(canAccess('adminOnly', member)).toBe(false);
    expect(canAccess('adminOnly', leader)).toBe(false);
    expect(canAccess('adminOnly', editor)).toBe(false);
    expect(canAccess('adminOnly', admin)).toBe(true);
  });

  it('finance: admin or a finance-flagged user; never a plain editor/member/anon', () => {
    expect(canAccess('finance', anon)).toBe(false);
    expect(canAccess('finance', member)).toBe(false);
    expect(canAccess('finance', editor)).toBe(false); // an editor is NOT finance
    expect(canAccess('finance', financeUser)).toBe(true); // finance flag, non-admin
    expect(canAccess('finance', admin)).toBe(true);
  });
});

// The authenticated request context exposed as `Astro.locals.user`. The row is
// reloaded from `people` (+ team memberships) on every request by the middleware
// so revocation is immediate (active=0 / deleted_at / session_epoch bump).
// Actual loading lands in slice-3 task 2; this file only defines the shape.
export type SessionUser = {
  id: number;
  email: string;
  displayName: string;
  role: 'member' | 'editor' | 'admin';
  isAdmin: boolean;
  isEditor: boolean;
  // Finance-team flag (people.finance): grants the `finance` route class (the
  // giving admin under /admin/giving) without full site-admin rights. 0 | 1.
  finance: number;
  memberTeamIds: number[];
  leaderTeamIds: number[];
  lang: 'en' | 'zh' | null;
  // Per-admin module permissions (spec 2026-07-10): super admins see every admin
  // area and manage other admins' grants; adminAreas holds a limited admin's
  // granted area keys (validated against src/lib/adminAreas.ts, [] for
  // non-admins). Loaded fresh each request, so revocation is immediate.
  isSuperAdmin: boolean;
  adminAreas: string[];
};

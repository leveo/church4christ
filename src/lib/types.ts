import type { GrantableArea } from './adminAreas';

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
  // Validated grants loaded from people.admin_areas. Admins may carry any
  // GrantableArea; member/editor scoped staff may carry only `newcomers`.
  // Legacy area strings are removed from non-admin sessions and cannot confer
  // authority. Loaded fresh each request, so revocation is immediate.
  isSuperAdmin: boolean;
  adminAreas: GrantableArea[];
};

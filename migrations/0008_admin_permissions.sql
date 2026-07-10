-- Per-admin module permissions (design spec 2026-07-10): `super_admin` marks the
-- admins who see everything and manage other admins' access; `admin_areas` is a
-- comma-separated list of granted area keys (validated against the allow-list in
-- src/lib/adminAreas.ts — prayer-wall and the member directory are always-on
-- defaults and never stored). Existing role='admin' rows are backfilled as super
-- admins so no already-deployed install loses access on upgrade.
ALTER TABLE people ADD COLUMN super_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN admin_areas TEXT NOT NULL DEFAULT '';
UPDATE people SET super_admin = 1 WHERE role = 'admin';

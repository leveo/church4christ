-- Page-builder module: custom pages gain a format discriminator and a JSON
-- layout tree (TEXT, app-layer JSON like revisions.snapshot_json — no native
-- JSON type on either backend). 'markdown' pages keep the classic body_md path;
-- 'builder' pages render layout_json through src/components/blocks. ADD COLUMN
-- is safe on both engines; the CHECK applies to new writes only, which is all
-- we need (every write goes through pagesDb.ts).
ALTER TABLE custom_pages ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'
  CHECK (format IN ('markdown','builder'));
ALTER TABLE custom_pages ADD COLUMN layout_json TEXT;

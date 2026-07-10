-- Postgres mirror of migrations/0007_page_builder.sql (see that file's header).
ALTER TABLE custom_pages ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'
  CHECK (format IN ('markdown','builder'));
ALTER TABLE custom_pages ADD COLUMN layout_json TEXT;

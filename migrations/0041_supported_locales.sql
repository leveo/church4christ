-- Language lookup table. Locale columns reference it (0042-0049) instead of a hard-coded
-- CHECK list, so supporting another language is an INSERT here, not a schema change.
-- The application registry (src/lib/locales.ts) decides which of these codes are offered;
-- the database permits the planned set of twelve.
CREATE TABLE supported_locales (
  code TEXT PRIMARY KEY CHECK (length(code) BETWEEN 2 AND 8)
);

INSERT INTO supported_locales (code) VALUES
  ('en'),
  ('zh'),
  ('es'),
  ('pt'),
  ('fr'),
  ('de'),
  ('ja'),
  ('ko'),
  ('ms'),
  ('id'),
  ('vi'),
  ('hi');

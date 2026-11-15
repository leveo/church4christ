-- people.lang: replace CHECK (lang IN ('en','zh')) with a foreign key to supported_locales.
--
-- people is referenced by more than a hundred tables, several with ON DELETE CASCADE,
-- SET NULL or RESTRICT, and D1 cannot switch foreign keys off. Dropping and recreating the
-- table would cascade into those children and lose data, so the column is replaced in
-- place instead: the values are copied aside, lang (a column-level CHECK that SQLite can
-- drop) is dropped and re-added with the foreign key, and the values are restored. The
-- column ends up last in the table; no code addresses people columns by position.
-- No trigger fires on lang. Back up before applying (docs/upgrade.md).
CREATE TABLE _locale_bak_people AS SELECT id, lang FROM people WHERE lang IS NOT NULL;
ALTER TABLE people DROP COLUMN lang;
ALTER TABLE people ADD COLUMN lang TEXT REFERENCES supported_locales(code);
UPDATE people SET lang = (SELECT lang FROM _locale_bak_people WHERE _locale_bak_people.id = people.id)
  WHERE id IN (SELECT id FROM _locale_bak_people);
DROP TABLE _locale_bak_people;

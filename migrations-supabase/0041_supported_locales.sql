-- Language lookup table. Locale columns reference it instead of a hard-coded
-- CHECK (locale IN ('en','zh')) list, so supporting another language is an INSERT here,
-- not a schema change. The application registry (src/lib/locales.ts) decides which of these
-- codes are offered; the database permits the planned set of twelve.
CREATE TABLE supported_locales (
  code TEXT PRIMARY KEY CHECK (length(code) BETWEEN 2 AND 8)
);

INSERT INTO supported_locales (code) VALUES
  ('en'), ('zh'), ('es'), ('pt'), ('fr'), ('de'), ('ja'), ('ko'), ('ms'), ('id'), ('vi'), ('hi');

-- Replace each unnamed single-column CHECK (col IN ('en','zh')) with a named foreign key.
-- The CHECK is found through pg_constraint (its generated name is not guaranteed), matched
-- on the column and on the locale list in its definition, dropped, and replaced by
-- <table>_<column>_locale_fk. No table is rebuilt and no row changes; adding the
-- constraint validates the existing rows, which are all 'en' or 'zh'.
DO $$
DECLARE
  target RECORD;
  found RECORD;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('people', 'lang'),
      ('ministry_i18n', 'locale'),
      ('team_i18n', 'locale'),
      ('position_i18n', 'locale'),
      ('service_type_i18n', 'locale'),
      ('testimonies', 'locale'),
      ('prayer_sheets', 'locale'),
      ('announcement_i18n', 'locale'),
      ('event_i18n', 'locale'),
      ('email_templates', 'locale'),
      ('custom_page_i18n', 'locale'),
      ('newcomer_status_i18n', 'locale'),
      ('newcomer_field_i18n', 'locale'),
      ('newcomer_field_option_i18n', 'locale'),
      ('newcomer_submissions', 'locale'),
      ('identity_recovery_notification_outbox', 'locale'),
      ('identity_giving_checkout_continuations', 'locale'),
      ('identity_registration_continuations', 'locale'),
      ('fund_i18n', 'locale'),
      ('reg_event_i18n', 'locale'),
      ('reg_question_i18n', 'locale')
    ) AS t(table_name, column_name)
  LOOP
    FOR found IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'c'
        AND c.conrelid = to_regclass(format('public.%I', target.table_name))
        AND array_length(c.conkey, 1) = 1
        AND a.attname = target.column_name
        AND pg_get_constraintdef(c.oid) LIKE '%''en''%'
        AND pg_get_constraintdef(c.oid) LIKE '%''zh''%'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', target.table_name, found.conname);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES supported_locales (code)',
      target.table_name,
      target.table_name || '_' || target.column_name || '_locale_fk',
      target.column_name
    );
  END LOOP;
END $$;

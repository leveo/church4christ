-- church4christ Postgres schema (Supabase backend).
-- Part 1: SQLite-compat functions. The app's SQL (and this schema's DEFAULTs)
-- call datetime('now', ...)/date('now', ...) exactly as they do on D1; these
-- functions implement the SQLite modifier forms the repo actually uses:
--   ±N minutes/hours/days/months/years, 'weekday N', 'start of day'.
-- All math is UTC, matching SQLite's datetime('now').
-- GOTCHA: Postgres parses bare date('literal') as a CAST ('now'::date) at parse
-- time, so a single-arg date('now') never reaches these functions; app SQL uses
-- date('now', 'start of day') instead (a tripwire test bans the bare form).

CREATE OR REPLACE FUNCTION sqlite_compat_apply(base timestamp, mods text[])
RETURNS timestamp
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m text;
  mm text[];
BEGIN
  FOREACH m IN ARRAY mods LOOP
    m := lower(btrim(m));
    mm := regexp_match(m, '^([+-]?\d+(?:\.\d+)?)\s+(second|minute|hour|day|month|year)s?$');
    IF mm IS NOT NULL THEN
      base := base + (mm[1] || ' ' || mm[2])::interval;
      CONTINUE;
    END IF;
    mm := regexp_match(m, '^weekday\s+(\d)$');
    IF mm IS NOT NULL THEN
      base := base + make_interval(days => ((mm[1]::int - EXTRACT(dow FROM base)::int) % 7 + 7) % 7);
      CONTINUE;
    END IF;
    IF m = 'start of day' THEN base := date_trunc('day', base); CONTINUE; END IF;
    IF m = 'start of month' THEN base := date_trunc('month', base); CONTINUE; END IF;
    IF m = 'start of year' THEN base := date_trunc('year', base); CONTINUE; END IF;
    RAISE EXCEPTION 'unsupported sqlite datetime modifier: %', m;
  END LOOP;
  RETURN base;
END;
$$;

CREATE OR REPLACE FUNCTION sqlite_compat_base(ts text)
RETURNS timestamp
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN lower(btrim(ts)) = 'now' THEN (now() AT TIME ZONE 'utc')
    ELSE ts::timestamp
  END;
$$;

CREATE OR REPLACE FUNCTION datetime(ts text, VARIADIC mods text[] DEFAULT '{}')
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_compat_apply(sqlite_compat_base(ts), mods), 'YYYY-MM-DD HH24:MI:SS');
$$;

CREATE OR REPLACE FUNCTION date(ts text, VARIADIC mods text[] DEFAULT '{}')
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_compat_apply(sqlite_compat_base(ts), mods), 'YYYY-MM-DD');
$$;

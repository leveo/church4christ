# Slice 2 — Schema & Core Libraries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The complete D1 schema (migrations + bilingual demo seed), the i18n-join query
helper, settings access, and the pure utility libs (validate, dates, youtube) — all
unit-tested under the workers pool.

**Architecture:** Spec §5 (schema), §7 (i18n pattern). One D1; `_i18n` companion tables;
COALESCE fallback to `en`. Reference implementations for porting live at
`/Users/leosong/Python/dcfc-serve` and `/Users/leosong/Python/dcfc-website` (read-only).

**Tech Stack:** D1 (SQLite), vitest + @cloudflare/vitest-pool-workers (configs exist
after slice 1), TypeScript strict.

## Global Constraints

- Migrations are append-only files `migrations/0001_init.sql`, `migrations/0002_email.sql`.
  The DDL in this plan is authoritative — transcribe verbatim (formatting may reflow).
- Conventions: INTEGER PRIMARY KEY rowids; TEXT dates `YYYY-MM-DD`; `TEXT NOT NULL
  DEFAULT (datetime('now'))` timestamps; soft delete `deleted_at TEXT` unless the table
  is listed hard-delete; CHECK constraints for enums; every FK indexed.
- Hard-delete tables: `blockout_dates`, `announcements`, `announcement_i18n`, `events`,
  `event_i18n`, `team_members`, `plan_positions`, `person_interests`, `settings`,
  `email_rules`, `email_templates`, `email_log`, `tokens`, `prayer_requests`,
  `prayer_activity`, `external_ids`.
- Locale values: `'en'`, `'zh'`. Default/fallback locale `'en'`.
- Seed data: fictional only (spec §11). People emails `@example.com` except none real.
  Admin person: `Alex Admin <admin@example.com>`, role `admin`.
- No DCFC/real data (names, addresses, ids). No `pco_*` columns — external linkage is the
  generic `external_ids` table only.
- Commit per task, conventional messages, ending:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Migration 0001 — identity, volunteer core, content, settings

**Files:**
- Create: `migrations/0001_init.sql`
- Test: `test/schema.test.ts`

**Interfaces:**
- Produces: all tables below, exactly these names/columns (later tasks and slices depend
  on them verbatim).

DDL (authoritative; PRAGMA-free, D1-compatible):

```sql
-- people: unified identities (members, volunteers, editors, admins)
CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,            -- stored lowercase
  phone TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','editor','admin')),
  active INTEGER NOT NULL DEFAULT 1,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  calendar_token TEXT UNIQUE,
  lang TEXT CHECK (lang IN ('en','zh')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE ministries (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  cover_key TEXT,
  leader_person_id INTEGER REFERENCES people(id),
  meeting_time TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE TABLE ministry_i18n (
  ministry_id INTEGER NOT NULL REFERENCES ministries(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  name TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (ministry_id, locale)
);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  ministry_id INTEGER REFERENCES ministries(id),
  sort INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE TABLE team_i18n (
  team_id INTEGER NOT NULL REFERENCES teams(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  name TEXT NOT NULL,
  PRIMARY KEY (team_id, locale)
);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  sort INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE TABLE position_i18n (
  position_id INTEGER NOT NULL REFERENCES positions(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  name TEXT NOT NULL,
  PRIMARY KEY (position_id, locale)
);

CREATE TABLE team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  is_leader INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (team_id, person_id)
);

CREATE TABLE service_types (
  id INTEGER PRIMARY KEY,
  start_time TEXT,                        -- HH:MM 24h, optional
  end_time TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE TABLE service_type_i18n (
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  name TEXT NOT NULL,
  PRIMARY KEY (service_type_id, locale)
);

CREATE TABLE plans (
  id INTEGER PRIMARY KEY,
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  plan_date TEXT NOT NULL,
  title TEXT,
  series TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (service_type_id, plan_date)
);

CREATE TABLE plan_positions (
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  position_id INTEGER NOT NULL REFERENCES positions(id),
  needed INTEGER NOT NULL DEFAULT 1,
  open_signup INTEGER NOT NULL DEFAULT 0,
  UNIQUE (plan_id, position_id)
);

CREATE TABLE roster_assignments (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  position_id INTEGER NOT NULL REFERENCES positions(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  status TEXT NOT NULL DEFAULT 'U' CHECK (status IN ('U','C','D')),
  decline_reason TEXT,
  is_signup INTEGER NOT NULL DEFAULT 0,
  assigned_by TEXT,
  notified_at TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (plan_id, position_id, person_id)
);

CREATE TABLE blockout_dates (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  reason TEXT,
  recurrence_group TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE team_applications (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  position_id INTEGER REFERENCES positions(id),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'P' CHECK (status IN ('P','A','R')),
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_app_pending_unique
  ON team_applications (person_id, team_id) WHERE status = 'P';

CREATE TABLE person_interests (
  person_id INTEGER NOT NULL REFERENCES people(id),
  category TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (person_id, category)
);

CREATE TABLE gift_results (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  top_gifts_json TEXT NOT NULL,
  recommended_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE testimonies (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id),
  author_name TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'P' CHECK (status IN ('P','A','R')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  person_id INTEGER NOT NULL REFERENCES people(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('login','respond')),
  assignment_id INTEGER REFERENCES roster_assignments(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Content
CREATE TABLE bulletins (
  id INTEGER PRIMARY KEY,
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  bulletin_date TEXT NOT NULL,
  service_time_label TEXT,
  program_json TEXT,                       -- [{item,content,person}]
  offering_json TEXT,                      -- [{label,amount}]
  attendance_json TEXT,                    -- [{label,count}]
  memory_verse TEXT,
  flowers TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  publish_at TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (service_type_id, bulletin_date)
);

CREATE TABLE bulletin_announcements (
  id INTEGER PRIMARY KEY,
  bulletin_id INTEGER NOT NULL REFERENCES bulletins(id),
  seq INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  link_url TEXT,
  link_label TEXT
);

CREATE TABLE sermons (
  id INTEGER PRIMARY KEY,
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  sermon_date TEXT NOT NULL,
  title TEXT NOT NULL,
  speaker TEXT NOT NULL DEFAULT '',
  scripture TEXT,
  youtube_id TEXT,
  series TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (service_type_id, sermon_date)
);

CREATE TABLE prayer_sheets (
  id INTEGER PRIMARY KEY,
  sheet_date TEXT NOT NULL UNIQUE,
  locale TEXT CHECK (locale IN ('en','zh')),
  sections_json TEXT,                      -- [{heading,items[]}]
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  publish_at TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE announcements (
  id INTEGER PRIMARY KEY,
  url TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE announcement_i18n (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  title TEXT NOT NULL,
  PRIMARY KEY (announcement_id, locale)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  image_key TEXT,
  url TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE event_i18n (
  event_id INTEGER NOT NULL REFERENCES events(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  title TEXT NOT NULL,
  blurb TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (event_id, locale)
);

CREATE TABLE prayer_requests (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','praying','long_term','waiting','answered','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE prayer_activity (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES prayer_requests(id),
  author TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('prayed','comment','moved')),
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE revisions (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN
    ('bulletin','sermon','prayer_sheet','announcement','event')),
  entity_id INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  edited_by TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE media (
  id INTEGER PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE external_ids (
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  system TEXT NOT NULL,
  external_id TEXT NOT NULL,
  UNIQUE (entity, entity_id, system)
);

CREATE INDEX idx_people_email ON people(email);
CREATE INDEX idx_teams_ministry ON teams(ministry_id);
CREATE INDEX idx_positions_team ON positions(team_id);
CREATE INDEX idx_team_members_person ON team_members(person_id);
CREATE INDEX idx_plans_date ON plans(plan_date);
CREATE INDEX idx_plan_positions_plan ON plan_positions(plan_id);
CREATE INDEX idx_roster_plan ON roster_assignments(plan_id);
CREATE INDEX idx_roster_person ON roster_assignments(person_id);
CREATE INDEX idx_blockouts_person ON blockout_dates(person_id);
CREATE INDEX idx_applications_team ON team_applications(team_id, status);
CREATE INDEX idx_gift_results_person ON gift_results(person_id, created_at);
CREATE INDEX idx_testimonies_status ON testimonies(status, locale);
CREATE INDEX idx_tokens_person ON tokens(person_id, purpose);
CREATE INDEX idx_bulletins_date ON bulletins(bulletin_date);
CREATE INDEX idx_bulletin_ann_bulletin ON bulletin_announcements(bulletin_id, seq);
CREATE INDEX idx_sermons_date ON sermons(sermon_date);
CREATE INDEX idx_prayer_requests_status ON prayer_requests(status, created_at);
CREATE INDEX idx_prayer_activity_request ON prayer_activity(request_id, created_at);
CREATE INDEX idx_revisions_entity ON revisions(entity, entity_id, edited_at);
```

- [ ] Step 1: failing test `test/schema.test.ts` (workers pool): after migrations apply
  (setup.ts already does), `SELECT name FROM sqlite_master WHERE type='table'` contains
  every table name above; inserting a person with `role='owner'` throws CHECK violation;
  inserting duplicate `(plan_id, position_id, person_id)` roster row throws; two pending
  applications for same person+team throw (partial index); `settings` upsert round-trips.
- [ ] Step 2: write the migration verbatim; run `npm test` → green.
- [ ] Step 3: `npm run db:migrate:local` applies cleanly on the local wrangler D1. Commit.

### Task 2: Migration 0002 — email tables + seeds

**Files:**
- Create: `migrations/0002_email.sql`
- Test: extend `test/schema.test.ts`

DDL:

```sql
CREATE TABLE email_rules (
  rule_key TEXT PRIMARY KEY CHECK (rule_key IN ('remind7','remind3','digestAM')),
  enabled INTEGER NOT NULL DEFAULT 0
);
INSERT INTO email_rules (rule_key, enabled) VALUES
  ('remind7', 1), ('remind3', 0), ('digestAM', 1);

CREATE TABLE email_templates (
  template_key TEXT NOT NULL CHECK (template_key IN ('remind','request','appResult','digestAM')),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (template_key, locale)
);

CREATE TABLE email_log (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  to_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent','delivered','opened','bounced','failed','devlog')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_email_log_created ON email_log(created_at);
```

Plus 8 `INSERT INTO email_templates` rows (en+zh for each key) with `{name}`, `{date}`,
`{position}`, `{link}` placeholders — write natural, warm church copy (en: "Hi {name},
you're scheduled to serve as {position} on {date}…"; zh: "{name} 平安！诚邀您于 {date}
担任 {position} 服事…").

- [ ] Steps: failing test (rules seeded with expected defaults; template zh 'remind'
  contains `{date}`) → migration → green → commit.

### Task 3: i18n join helper + settings + db core

**Files:**
- Create: `src/lib/db.ts`, `src/lib/settings.ts`
- Test: `test/db.test.ts`, `test/settings.test.ts`

**Interfaces:**
- `src/lib/db.ts` produces:
  - `type Locale = 'en' | 'zh'` re-export from `./locales`
  - `i18nJoin(table: string, alias: string, fkCol: string, cols: string[], locale: string)
    -> { select: string, joins: string }` — builds
    `LEFT JOIN <table> <alias>_l ON <alias>_l.<fkCol> = <alias>.id AND <alias>_l.locale = '<locale>'
     LEFT JOIN <table> <alias>_d ON <alias>_d.<fkCol> = <alias>.id AND <alias>_d.locale = 'en'`
    and select fragments `COALESCE(<alias>_l.<col>, <alias>_d.<col>) AS <col>`.
    Locale value must be validated against LOCALES (never interpolate user input).
  - `getPersonByEmail(db, email)` (lowercases), `getPersonById(db, id)`
  - `listMinistries(db, locale)` → active, sorted, with name/intro coalesced +
    aggregate counts (teams, open slots) — port shape from dcfc-serve `ministryDb.listMinistriesForCongregation` minus congregation.
- `src/lib/settings.ts` produces:
  - `getSettings(db, keys: string[]): Promise<Record<string,string>>`
  - `getSetting(db, key, fallback='')`, `setSetting(db, key, value)` (upsert)
  - `getSiteIdentity(db, locale)` → `{name, tagline, address, email, phone, serviceTimes,
    givingUrl, youtubeUrl, mapUrl}` reading `site.*` keys with `.<locale>` suffix
    fallback to `.en` (e.g. `site.name.zh` → `site.name.en`)
  - `getTheme(db)` → `{ theme: string, defaultMode: string }` from `theme.name`/`theme.default_mode`
    with defaults `sanctuary`/`light` when unset.
- [ ] Steps: TDD each helper against real D1 (insert fixture rows in test); green; commit.

### Task 4: validate + dates + youtube utils

**Files:**
- Create: `src/lib/validate.ts`, `src/lib/dates.ts`, `src/lib/youtube.ts`
- Test: `test/validate.test.ts`, `test/dates.test.ts`, `test/youtube.test.ts`
- Reference: PORT from `/Users/leosong/Python/dcfc-website/src/lib/{validate,dates,youtube}.ts`
  and their tests — adapt: bulletins gain `service_type_id` + `service_time_label` +
  offering/attendance/verse/flowers (superset), announcements/events parse per-locale
  title/blurb field pairs (`title_en`, `title_zh`, `blurb_en`, `blurb_zh` form names),
  error messages in English (they render through dictionaries later; validate returns
  error KEYS like `errors.dateFormat`, not prose).

**Interfaces (used by slices 5–6):**
- `parseBulletinForm(form: FormData): { ok: true, data: BulletinInput } | { ok: false, errors: Record<string,string> }`
  — BulletinInput: `{serviceTypeId:number, bulletinDate:string, serviceTimeLabel:string|null,
  program: {item:string,content:string,person:string}[], offering:{label:string,amount:string}[],
  attendance:{label:string,count:string}[], memoryVerse:string|null, flowers:string|null,
  status:'draft'|'published', publishAt:string|null,
  announcements:{title:string,body:string,linkUrl:string|null,linkLabel:string|null}[]}`
- `parseSermonForm`, `parsePrayerSheetForm`, `parseAnnouncementForm` (i18n titles),
  `parseEventForm` (i18n title/blurb), `parsePersonForm`, `parseSettingsForm` — same
  result-shape pattern.
- `dates.ts`: `isValidDateStr(s)`, `todayInTz(tz='America/Chicago')`, `addDays(dateStr, n)`,
  `nextWeekday(fromDateStr, weekday)` , `formatDate(dateStr, locale)` (en: "July 5, 2026",
  zh: "2026年7月5日"), `datetimeLocalToUtc(s)`, `utcToDatetimeLocal(s)`.
- `youtube.ts`: `extractYouTubeId(input: string): string | null` — accepts bare 11-char id,
  watch?v=, youtu.be/, live/, embed/, shorts/ URLs; rejects everything else.
- [ ] Steps: port tests first (adapt cases), then libs; green; commit.

### Task 5: Demo seed

**Files:**
- Create: `seed/dev-seed.sql`
- Test: `test/seed.test.ts` (applies seed file content after migrations in the test
  DB — read file via vitest `?raw` import or fs — then asserts: admin person exists with
  role admin; every ministry has BOTH en and zh i18n rows; ≥2 published bulletins;
  ≥8 sermons published across 2 service types; announcements/events have both locales;
  settings rows cover every `site.*`/`theme.*` key `getSiteIdentity`/`getTheme` read).

Content (spec §11, all fictional):
- settings: site.name.en `Church4Christ`, site.name.zh `四方基督教会`, taglines,
  address `123 Grace Avenue, Springfield, TX 75000`, email `hello@church.yunfei-song.com`,
  phone `(555) 010-4444`, map_url `https://maps.example.com/church4christ`,
  giving_url `https://give.example.com/church4christ`, youtube_url
  `https://www.youtube.com/@church4christ-demo`, service_times per locale,
  theme.name `sanctuary`, theme.default_mode `light`, locale.default `en`.
- people: Alex Admin admin@example.com (admin); Pastor David Chen 陈大卫 (editor);
  8 volunteers bilingual display names, @example.com.
- 10 ministries (spec list) × en+zh i18n rows, emoji icons, categories:
  worship/children/youth/college/family/seniors/missions/care/hospitality/av-tech.
- 3 teams (Worship 敬拜队 / AV 媒体技术 / Hospitality 招待) under matching ministries,
  8 positions bilingual, members + leaders.
- 2 service_types: en "Sunday Worship (English)" zh "主日崇拜（英文）" 09:30–10:45;
  en "Chinese Sunday Worship" zh "中文主日崇拜" 11:00–12:15.
- plans: next 8 Sundays × both service types (dates relative to 2026-07-05, fixed
  literals are fine); plan_positions with a couple `open_signup=1`; roster examples
  U/C/D incl. one decline_reason.
- 1 blockout, 3 team_applications (P/A/R one each), 2 person_interests, 1 gift_result.
- 4 testimonies: 2 en + 2 zh, 3 published (A) 1 pending (P).
- bulletins: per service type 2 published + 1 draft, full program/offering/attendance/
  memory_verse/flowers + 3 bulletin_announcements each; zh-service bulletins in Chinese.
- 10 sermons across both types (series per spec), youtube_id `dQw4w9WgXcQ`-style dummies,
  1 draft.
- 2 prayer_sheets (zh locale, sections_json), published.
- 4 announcements + 3 events, i18n rows both locales, one event windowed to the past
  (inactive display case), image_key NULL (SVG placeholder path handled in slice 4).
- 5 prayer_requests spread across statuses + prayer_activity rows.

- [ ] Steps: failing seed test → write seed → green → `npm run db:seed:local` applies →
  commit.

## Self-review checklist (executor runs at end)

- `npm test` fully green, no snapshot noise; `npm run check` green; `npm run build` green.
- `wrangler d1 migrations apply church4christ-db --local` + seed run clean from scratch
  (delete `.wrangler/state` first to prove idempotence of the pair).
- `rg -in "dcfc|plano|glencliff|leveosong|churchcenter" migrations/ seed/ src/lib/` → 0 hits.
- Every table in spec §5 exists in a migration; every seed FK resolves (PRAGMA
  foreign_key_check clean).

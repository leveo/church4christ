-- Pledges (the optional `pledges` module). Postgres twin: migrations-supabase/0047_pledges.sql.
-- A pledge campaign collects written intentions to give over a period: each pledge stores the person's details,
-- the server-calculated plan, and one dated row per planned gift. Planned gifts are intentions, not payments;
-- nothing here records money received. Every change to a pledge appends to pledge_events. Staff actions record
-- the signed-in administrator's email as text, so no table here references people(id).
-- campus_id mirrors 0027_multi_campus.sql (a plain column with a default, no foreign key).

CREATE TABLE pledge_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  pledge_opens TEXT,                        -- YYYY-MM-DD: first day the public form accepts pledges (NULL = now)
  pledge_closes TEXT,                       -- YYYY-MM-DD: last day the public form accepts pledges (NULL = open)
  giving_start TEXT NOT NULL,               -- YYYY-MM-DD: earliest planned gift
  giving_end TEXT NOT NULL,                 -- YYYY-MM-DD: latest planned gift, including the final one
  max_months INTEGER NOT NULL DEFAULT 36 CHECK (max_months BETWEEN 1 AND 120),
  goal_cents INTEGER CHECK (goal_cents IS NULL OR goal_cents > 0),
  household_goal INTEGER CHECK (household_goal IS NULL OR household_goal > 0),
  gift_guide TEXT NOT NULL DEFAULT '[]',    -- JSON [{ "households": 3, "totalCents": 500000 }, ...]
  currency TEXT NOT NULL DEFAULT 'usd',
  fund_id INTEGER,                         -- Giving fund that receives this campaign's gifts (read only while Giving is on. No FK: D1 has no funds table)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1,
  CHECK (giving_end >= giving_start),
  UNIQUE (campus_id, slug)
);

CREATE TABLE pledge_campaign_i18n (
  campaign_id INTEGER NOT NULL REFERENCES pledge_campaigns(id) ON DELETE CASCADE,
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  title TEXT NOT NULL DEFAULT '',
  intro_md TEXT NOT NULL DEFAULT '',
  campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (campaign_id, locale)
);

CREATE TABLE pledges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES pledge_campaigns(id),
  code TEXT NOT NULL UNIQUE,                -- eight letters shown to the person and staff
  idempotency_key TEXT UNIQUE,              -- online submissions only; a retry returns the same pledge
  fingerprint TEXT,                         -- hash of the submitted fields, to refuse a reused key
  pledge_type TEXT NOT NULL DEFAULT 'initial' CHECK (pledge_type IN ('initial','additional')),
  parent_id INTEGER REFERENCES pledges(id), -- the original pledge an additional pledge adds to
  name TEXT NOT NULL,
  email TEXT,                               -- optional on a paper card entered by staff
  phone TEXT NOT NULL DEFAULT '',
  household TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL CHECK (mode IN ('total','installment')),
  frequency TEXT NOT NULL CHECK (frequency IN ('once','monthly','quarterly','yearly','custom')),
  interval_months INTEGER NOT NULL CHECK (interval_months >= 1),
  duration_months INTEGER NOT NULL CHECK (duration_months >= 1),
  gift_count INTEGER NOT NULL CHECK (gift_count >= 1),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  installment_cents INTEGER NOT NULL,
  final_cents INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  giving_method TEXT NOT NULL DEFAULT 'online' CHECK (giving_method IN ('online','check','cash','other')),
  giving_note TEXT NOT NULL DEFAULT '',
  signer_name TEXT NOT NULL DEFAULT '',
  consent INTEGER NOT NULL DEFAULT 0 CHECK (consent IN (0,1)),
  source TEXT NOT NULL DEFAULT 'online' CHECK (source IN ('online','paper')),
  locale TEXT NOT NULL DEFAULT 'en' REFERENCES supported_locales(code),
  email_status TEXT NOT NULL DEFAULT 'none' CHECK (email_status IN ('none','pending','sent','failed')),
  staff_note TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_pledges_campaign ON pledges(campaign_id, archived_at);
CREATE INDEX idx_pledges_email ON pledges(email);

CREATE TABLE pledge_installments (
  pledge_id INTEGER NOT NULL REFERENCES pledges(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  gift_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (pledge_id, seq)
);
CREATE INDEX idx_pledge_installments_date ON pledge_installments(gift_date);

CREATE TABLE pledge_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pledge_id INTEGER NOT NULL REFERENCES pledges(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('created','edited','archived','restored','email_sent','email_failed')),
  actor TEXT NOT NULL DEFAULT '',           -- an administrator's email, or '' for the person's own online form
  changes TEXT NOT NULL DEFAULT '[]',       -- JSON list of changed field names (values are not copied here)
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_pledge_events_pledge ON pledge_events(pledge_id, id);

-- Pledges stays off until an administrator turns it on in Settings -> Modules. A fresh database has no module
-- rows and no people yet, so setup's own module choices apply there (setup writes every module row, and no
-- preset includes this one). An explicit row is never changed.
INSERT INTO settings (key, value)
SELECT 'module.pledges', '0'
WHERE EXISTS (SELECT 1 FROM settings WHERE key LIKE 'module.%')
   OR EXISTS (SELECT 1 FROM people)
ON CONFLICT(key) DO NOTHING;

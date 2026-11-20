# Changelog

This file records changes that affect churches, nonprofit operators, implementers, and
maintainers. Version 1.0.0 is the initial open-source release; upgrade notes are part of the
change contract, so read the relevant entries before moving an installation forward.

Earlier development history is intentionally not reconstructed as releases. The source
package remains private because Church4Christ is distributed from this repository rather
than published to npm.

## [Unreleased]

### Added

- An `event-registration` setup preset for churches that only want event sign-up. It turns on
  Registration alone and runs on the default Cloudflare D1 database, where every event is free:
  `npm run onboard -- --preset event-registration`. Paid events need Supabase (PostgreSQL) and
  Stripe from the start (`--backend supabase`); Event Logistics stays a later opt-in in
  **Settings → Modules**. A new `church-event-registration` entry in `config/editions.json`
  describes the matching single-feature edition. See [docs/editions.md](docs/editions.md).
- With the Events module off and Registration on, the home page lists the events people can sign
  up for in the upcoming-events spot. The admin dashboard has a **Registration** shortcut.

### Changed

- Operator impact: none for existing installations. No migrations, bindings, secrets, or module
  defaults change. The `event-registration` preset only affects new installations, and its
  module list (Registration) is fixed from this release on.

### Fixed

- Registration on D1: the admin menu no longer links to **Stripe operations**, which failed there
  because its tables exist only on Postgres, and the payment operations permission is no longer
  offered. Super admins can give a staff member the **Registration** area again; the checkbox was
  disabled on D1. The setup doctor no longer asks a D1 site to configure Stripe, which it cannot
  use. Without the Member Portal, pressing **Register** twice lands on the confirmation page
  instead of a missing **My events** page.

## [1.7.0] - 2026-11-20

Upgrading from 1.6.0: see [Upgrading 1.6.0 to 1.7.0](docs/upgrade.md#upgrading-160-to-170).
This release is about event registration: free events on D1, household and group sign-up,
an event builder, a back office with a phone check-in desk, and an optional event logistics module.

### Added

- Registration now runs on Cloudflare D1 for free events. Paid events still need
  Supabase (PostgreSQL) and Stripe; on D1 the admin price field is disabled and a priced event
  is refused. Events have four stages (Hidden, Preview, Open, Closed) with **Open now**,
  **Close now**, **Hide**, and **Show** buttons and a **Visible from** time. Admins can duplicate
  an event (details and questions, not registrations; the copy starts hidden), write titles,
  descriptions, and question labels in every enabled site language, and add an optional poster
  image and an optional confirmation-number prefix. Seat limits no longer allow overselling.
  Free events can use a waitlist (on by default per event, can be turned off; paid events never
  waitlist). Every registration gets a confirmation number such as `R26-0001` and a party size. Guests still
  verify their email before registering. See [docs/features/registration.md](docs/features/registration.md).
- Registration for households and groups. An event has a **Max people per registration**
  setting (1 to 20, default 1). Signed-in members add household members with one tap. The whole
  party takes seats together; if it does not fit a free event with a waitlist, the whole party
  joins the waitlist. A paid sign-up costs the price times the number of people. Phone is
  optional, and a review step ("Review and confirm") shows everything before saving.
- Registration emails and a private page. Each registration gets a confirmation number and a QR
  code. Confirmed, waitlist, paid-confirmed (after Stripe), promotion and cancellation emails go
  out in the registrant's language, with a calendar (.ics) file and a private **Manage my
  registration** link. A newer email replaces the link from an older one, so only the latest
  link works. On that page (and from **My events** for signed-in members) people can edit
  names, phone and answers, press **Can't come** for one person, or cancel all, while the event
  is in Preview or Open and the new **Allow self-service changes** setting (on by default) is on.
  Paid cancellations are not refunded automatically; people are told to contact the office.
- Automatic waitlist promotion on free events when seats free up, oldest first. A party that does
  not fit is skipped for a smaller one behind it. Promoted people get an email.
- Event notes in every language, shown on the event page, the manage page and in emails.
- The roster shows people and phone, and the CSV adds **People** and **Phone** as the last columns.
  See [docs/features/registration.md](docs/features/registration.md).
- Registration form builder, ticket types and templates. On an event's admin page, build the
  form with question cards you drag into order. Types: short and long text, dropdown,
  checkboxes, yes/no, number, date, email, phone, section heading, and terms agreement.
  Ask once per registration or for each person, mark questions required, add help text,
  placeholders and a maximum length, translate labels and options into every site language,
  and use "Show only if…" to show a question when an earlier answer matches. A question that
  another depends on cannot be deleted, and a question with answers cannot switch between
  per-registration and per-person. Ticket types (such as Adult and Child) have their own price,
  optional limit and description; each person picks one, the event price is ignored when types
  exist, and limits hold without overselling (the whole group joins the waitlist on a free
  event). On D1 ticket prices must be free. The server records when a person agreed to the
  terms. Save an event as a template, start a new event from a template, or delete templates;
  templates never appear publicly. Public form, review, manage page, My events, emails and
  roster show ticket types and per-person answers, and list pages show **Full** when every
  ticket type is sold out. See [docs/features/registration.md](docs/features/registration.md).
- Page builder **Registration** block: pick an event and show its title, date, place, optional
  seats left, and the right state (opens on a date, full or waitlist, closed) with a button
  (custom label; **View details** before sign-up opens). Hidden and template events render
  nothing. Events cards in **Admin → Events** have an optional **Link to a registration event**
  picker. See [docs/features/page-builder.md](docs/features/page-builder.md).
- Registration back office. Each event has a page for staff with an overview (seats taken and
  left, waitlist, sign-ups awaiting a decision, check-ins, people per ticket type, a tally for
  every dropdown, checkbox and yes/no question, and money collected and refunded on events that
  took payment) and a roster with search, status, ticket type, check-in and answer filters,
  sorting, paging, and a per-registration or per-person view. A detail panel shows the history
  of every change and lets staff edit the contact, people and answers, change a person's ticket
  type, add or remove a person, move between the waitlist and confirmed, cancel, resend the
  confirmation, and keep a staff note. If someone else changed the registration first, the save
  is refused with "reload and try again"; going over a seat or ticket limit asks for a confirm.
  **Requires approval** (free events only): new sign-ups wait **In review** and hold their seats
  until staff press Accept, Waitlist or Decline, and each decision emails the registrant; on these
  events the waitlist moves people up into review, not straight to confirmed. Staff can add
  walk-in and phone registrations by hand (paid events record cash or check, or complimentary;
  never a card charge), see possible duplicates, set a reminder email N days before the event,
  and email everyone in a filtered group (plain text with `{name}`, `{event}` and
  `{confirmation}`; the first 20 go at once, the rest hourly). A phone-first **check-in desk** at
  `/admin/registration/<id>/checkin` finds people by search or by scanning the QR code in their
  email, checks people in, undoes, checks out or checks in a whole group, asks for a ticked
  confirm before checking in anyone not confirmed, keeps several desks in step every 10 seconds,
  and shows only names, ticket types, the confirmation number and the status. Printable badges
  and a sign-in sheet, and a new one-row-per-person CSV. On Postgres with Stripe, staff with
  payment operations can refund all or part of a card payment (optionally cancelling), Stripe's
  refund notices update the same running total without double counting, and offline refunds can
  be recorded. Registration admins can give any member a **Viewer**, **Check-in desk** or
  **Registrar** role on one event; the role is checked before the page runs and again for every
  action. See [docs/features/registration.md](docs/features/registration.md).
- Registration event logistics, an optional module (`event-logistics`, off by default, needs
  Registration, works on D1 and Postgres). Each event turns on any of **Housing (rooms)**,
  **Tables (seating)** and **Small groups**, which add tabs to the event page. Housing has places
  to stay (hotel, dorm or cabin, campsite, other), room types and rooms added by range
  (`101-120, A1-A6`); rooms start not ready and must be marked ready before anyone is placed.
  Dorms and campsites default to fixed beds (a full room refuses), hotels and other places to
  flexible beds (going over asks first); each place can change it. Rooms can be for anyone, a
  single gender (by a per-person question chosen in the event settings) or one party only;
  breaking the rule asks first. People are put in rooms with the rest of their party by default,
  moved, swapped, or taken out, and moving or removing someone already checked in asks for a
  reason kept in the history. Tables are added in bulk and seated by hand or by **Auto-seat**:
  a preview that keeps parties together and fills tables evenly, keeps existing seats or starts
  over, and can spread out people with one tag and give tables with one tag a host with another;
  applying refuses if anything changed since the preview. Small groups have an optional size
  limit and a leader, and can be filled from the answer to a per-person choice question (one
  group per answer, reusing a group already named after it). Staff tags label people by hand or
  by answer. Prints: room list, door signs, table list, table cards and group list, with names
  only. Only confirmed and in-review people can be placed (waitlisted people once checked in;
  never people awaiting payment). Cancelling a person or registration, or declining a sign-up,
  frees their room, seat and group; moving to the waitlist keeps them. The check-in desk shows
  each person's room and table, and registrants see their room, table and group on the manage
  page, My events and the reminder email when the event's **Show registrants** switch is on.
  New copy in German, Spanish, French, Portuguese, Japanese, Korean, Vietnamese, Indonesian,
  Malay and Hindi is AI-assisted; community review welcome. See
  [docs/features/event-logistics.md](docs/features/event-logistics.md).

### Changed

- Operator impact for Registration event logistics (see [Upgrading](docs/upgrade.md#registration-event-logistics)):
  - D1: apply `migrations/0054_registration_logistics.sql`. Postgres: apply
    `migrations-supabase/0046_registration_logistics.sql`. Both add defaulted columns to
    `reg_events` and ten new tables, with no backfill. The setup doctor now expects the new
    tables.
  - The module stays off after upgrading (the migration writes `module.event-logistics = 0` on a
    database with data) until an administrator enables it in **Settings → Modules**; then each
    event turns on its own parts. No preset includes it.
  - No new secrets, bindings, cron triggers, or dependencies.
  - People with a role on one event also reach that event's five logistics prints
    (`room-list`, `door-signs`, `table-list`, `table-cards`, `group-list`) with the view role.
  - Identity merge: who placed a person is kept as history; no new merge conflict.

- Operator impact for Registration back office (see [Upgrading](docs/upgrade.md#registration-back-office)):
  - D1: apply `migrations/0053_registration_back_office.sql`. Postgres: apply
    `migrations-supabase/0045_registration_back_office.sql`. Both add defaulted columns and the
    tables `reg_checkins`, `reg_activity`, `reg_event_access` and `reg_outbox`, and backfill
    `payment_method = 'stripe'` where a Stripe Checkout session exists. The setup doctor now
    expects the four new tables.
  - New npm dependency `jsqr`, loaded only on the check-in desk page.
  - No new secrets, bindings, or cron triggers. The daily `0 13 * * *` job also sends event
    reminders (up to 40 per run) and the hourly `0 * * * *` job also sends queued bulk email (up
    to 60 per run).
  - People with a role on one event reach only `/admin/registration/<id>` (with its exports,
    badges and sign-in sheet) and `/admin/registration/<id>/checkin`. Per-event viewers and
    registrars can now download that event's CSV.
  - Identity merge: a person with a role on one event is a hard conflict, like an event admin.
  - Both roster CSVs now start with a UTF-8 byte-order mark. Columns are unchanged, but a script
    that reads the first column header may need to strip the mark.
- Operator impact for Registration form builder (see [Upgrading](docs/upgrade.md#registration-form-builder-ticket-types-and-templates)):
  - D1: apply `migrations/0052_registration_builder.sql`. Postgres: apply
    `migrations-supabase/0044_registration_builder.sql`. Existing option text becomes option keys
    with the labels copied; stored answers are not rewritten.
  - No new secrets, bindings, or cron triggers.
  - The roster CSV appends **Ticket types** (only for events with types) and per-person question
    columns at the end. Earlier columns are unchanged.
  - The admin question editor is now a React island (admin pages only). Public pages are unchanged.
- Operator impact for Registration (see [Upgrading](docs/upgrade.md#upgrading-160-to-170)):
  - D1: apply `migrations/0050_registration_d1.sql`. It creates the registration tables plus
    `group_reg_events` and `event_admins` (used by the Member Portal's event prayers and the
    event-admins panel). Existing D1 installations keep Registration **off** after upgrading
    (the migration writes `module.registration = 0`) until an administrator enables it in
    **Settings → Modules**. Fresh installs follow setup's module choice. The setup doctor now
    expects these tables on D1.
  - Postgres: apply `migrations-supabase/0042_registration_v2.sql`. It adds columns and
    backfills existing registrations with a legacy idempotency key, one attendee row each, and
    a per-event confirmation number in id order.
  - The roster CSV column order changed to Confirmation, Name, Email, Status, Party size,
    Amount, Registered, then the questions. Update any script that reads exports by position.
  - Identity merge: on D1, a person who is an event admin is now a hard merge conflict, the
    same as on Postgres.
  - Setup treats only Giving (not Registration) as requiring Postgres.
- Operator impact for Registration party flow (see [Upgrading](docs/upgrade.md#registration-party-flow-and-emails)):
  - D1: apply `migrations/0051_registration_party.sql`. Postgres: apply
    `migrations-supabase/0043_registration_party.sql`. Both only add columns, with no backfill.
    Existing events stay at 1 person per registration with self-service on.
  - Registration pages and the admin events list now show dates and times in the church's time
    zone. They showed UTC before.
  - The private page's API needs `NEWCOMER_RATE_LIMIT_SECRET`. Setup generates it; an install
    without it shows "can't load right now". Signed-in member sign-ups need the
    `IDENTITY_SOURCE_KEY_*` secrets, which setup manages.
  - The existing daily cron (`0 13 * * *`) now also retries unsent confirmation emails. There is
    no new cron. The first run after the upgrade does not email older registrations.
  - `/register/qr/...` is a public, cacheable image route that holds only the confirmation
    number. Email links end in `?campus=<slug>`. Email delivery needs the Cloudflare email
    binding, as for other emails.
  - The roster CSV gains **People** and **Phone** as the last columns; earlier columns keep
    their order.

### Fixed

- Maintainers: CI now prints the Vitest results for the Postgres steps as well as writing the
  JSON report, so a failing test is named in the log. Postgres tests pin their session to UTC, so
  identity-merge step-up checks no longer fail on a local server whose time zone is not UTC.

## [1.6.0] - 2026-11-14

Upgrading from 1.5.0: see [Upgrading 1.5.0 to 1.6.0](docs/upgrade.md#upgrading-150-to-160).

### Added

- Language infrastructure (no operator action required for the language settings themselves). A registry of
  supported languages, installation-wide `locale.enabled` / `locale.default` settings editable
  under **Settings → Languages**, a requested → default → English fallback chain, language
  negotiation at `/` (cookie from the switcher, `Accept-Language`, default), a switcher that
  becomes a dropdown above three languages, a reusable per-language tabbed editor in admin
  forms, and `--locales` / `--default-locale` setup flags with a multi-select in onboarding.
  Upgraded installations keep exactly English and Chinese with English as the default; nothing
  changes until an administrator saves new language settings. Disabling a language hides it and
  never deletes content. Setup manifests are `schemaVersion: 2` (version 1 still reads) and
  onboarding preferences are `schemaVersion: 2` (version 1 still reads). `--locale x` alone keeps its
  earlier meaning (English and Chinese enabled, x the default); `--locales` narrows or widens the set. See [docs/i18n.md](docs/i18n.md).

- Language support for ten more languages: Spanish (`es`), Brazilian Portuguese (`pt`, BCP-47
  `pt-BR`), French, German, Japanese, Korean, Malay (`ms`), Indonesian (`id`), Vietnamese, and
  Hindi are registered and selectable in Settings and onboarding, each with its own lazily loaded
  dictionary file. All ten are fully translated (AI-assisted, glossary-guided, and checked by
  `scripts/i18n/check.mjs` for keys, placeholders, HTML tags, script, and untranslated copy;
  community review welcome). Upgraded installations still enable only English and Chinese. Japanese, Korean,
  and Devanagari get system font stacks and Japanese and Korean the CJK line height. A
  translation toolkit ships with it: `scripts/i18n/export-keys.mjs`, `scripts/i18n/check.mjs`, a
  church glossary in `docs/i18n/glossary.md`, and per-language capability and readiness copy in
  `src/i18n/catalog/<code>.json`. See [docs/i18n.md](docs/i18n.md).
- The README is available in all twelve languages (`README.<code>.md`, AI-assisted) with a
  language bar at the top; `README.md` stays English and authoritative. The short Chinese summary
  section in the English README is replaced by the full Chinese README. See
  [README translations](docs/i18n.md#readme-translations).
- Admin editors for ministries, teams, service types, custom pages, events, announcements,
  navigation links, and the site identity settings (name, tagline, service times) now read and
  write every enabled language, not only English and Chinese.

### Changed

- The "Han text means Chinese" display heuristic for legacy sermons, bulletins, and plan
  subtitles now applies only to Latin-script languages. Japanese, Korean, and Hindi pages no
  longer hide rows because they contain Han characters. Prayer sheets and testimonies are matched
  by their explicit language along the fallback chain.
- Locale columns now reference a `supported_locales` lookup table instead of a hard-coded
  `CHECK (locale IN ('en','zh'))`, so adding a language later is an `INSERT`, not a schema
  change. Operator impact: apply the new forward migrations before deploying. D1 gets
  `0041`-`0049` (the lookup table, then rebuilds of the translation and related tables; back up
  first, rebuild time grows with table size), and Supabase/PostgreSQL gets `0041`. No data
  changes and no behavior changes; an upgraded installation still offers English and Chinese until an
  administrator enables more languages. See [Language lookup migrations](docs/upgrade.md#language-lookup-migrations).

- New Church4Christ logo: a teal church and cross sheltering an orange figure that forms a
  "4". The browser favicon, the onboarding page, the README header, and the 1280×640
  social preview use it, and the demo seed sets it as the demo church's logo
  (`site.logo_image_key`). Source files and colors are in `docs/images/brand/`. Existing
  installations keep their own uploaded logo; only the favicon changes for them.

### Fixed

- In the ten newer languages the public header put every link under **More**; built-in links
  now sort into Welcome, Explore, Connect, and Get Involved in every supported language.
- A paid Registration checkout started from a page in one of the ten newer languages failed its
  stored-request check during Stripe recovery; any supported language now passes.
- The serving menu's "Serve" link highlights correctly in every supported language.

## [1.5.0] - 2026-11-14

Upgrade notes: [Upgrading 1.4.0 to 1.5.0](docs/upgrade.md#upgrading-140-to-150):
[Member Portal on D1](docs/upgrade.md#member-portal-on-d1),
[Production Giving](docs/upgrade.md#production-giving),
[Service Planning](docs/upgrade.md#service-planning).

### Added

- Member Portal now runs on the default Cloudflare D1 database: households, groups and
  protected group files, calendar, opportunity discovery, and church, group, and private
  prayers. New D1 migration `0039_member_portal_d1.sql` adds the `group_files` and
  `prayer_items` tables. Demo prayer items are part of the D1 demo seed.
- Production Giving on Supabase and Stripe. Stripe now has an explicit live mode
  (`STRIPE_MODE=live` plus `STRIPE_LIVE_CONFIRMED=1`) alongside the default test mode.
  Checkout offers cards, wallets, and ACH bank debits (`us_bank_account`); Stripe emails
  per-payment receipts; donors change or cancel recurring gifts in Stripe's Billing Portal;
  yearly recurring gifts are supported. ACH gifts are recorded as pending and settle or fail
  from Stripe events.
- Giving ledger accuracy: each gift records live or test mode, the Stripe payment time
  (`paid_at`), refunded amounts (partial refunds are netted out), the charge id, and
  `disputed` status. Refunds and disputes are matched to gifts by the database, including
  refunds of recurring payments. `invoice.payment_failed` marks a recurring gift past due
  without any app email, and `customer.subscription.updated` syncs amount, interval, and fund.
- Annual giving statements: a printable page at `/my/giving/statement/<year>` and an admin
  page at `/admin/giving/statements` that queues a statement email for every donor, drained
  in small batches by the existing five-minute job (no new schedule).
- Giving admin: funds gain a description, a default flag, and a tax-deductible flag; manual
  gifts use the `giving.currency` setting; totals are per currency and net of refunds; CSV
  export of gifts; audit rows for manual gifts, fund edits, statement batches, and exports.
- PostgreSQL migration `0039_giving_production.sql` (details under Operator impact).
- **Service Planning** (`planning`, 服事流程): a timed run sheet for each service or event
  (live start times, fixed starts, overrun and overlap warnings, leader-only cue notes, print
  view, copy from a previous event), rehearsal sessions with called people and call times,
  member availability windows, a "find a time" search that ranks slots by conflicts, a team
  availability calendar, rehearsals and run-sheet duties in the member calendar and calendar
  feed, and automatic email on schedule, change, cancel, and a reminder. It is a new module in
  Volunteering that works on D1 and Supabase. See
  [`docs/features/service-planning.md`](docs/features/service-planning.md).

- The Supabase setup guide opens its Stripe section with a short, no-code overview for churches
  and nonprofits, linking Stripe's official pages for account activation, the nonprofit fee
  discount, receipts, the customer portal, ACH, keys, webhooks, and test cards.

### Changed

- Children's check-in and volunteer scheduling now work at phone width (375px): Today
  check-ins are cards with a full-width Check out button, the scheduling matrix and the
  availability grid become per-date and per-member cards, kiosk inputs open the right phone
  keyboard, and buttons, inputs and the admin top bar meet touch-size targets with 16px
  inputs. The Kiosk tab shows a QR code of the kiosk link, drawn on the server with the new
  `qrcode-generator` dependency (MIT, no dependencies). Forms that carried a `data-confirm`
  message (deleting a team or service type) now actually ask before submitting. The Accept or
  Decline email shows a short button instead of the raw link. Installing the update needs
  `npm ci` only; there are no migrations or settings to change.
- `portal` no longer requires the Supabase backend; only Giving and Registration do. A
  portal-only selection now resolves to D1, and a selection that also includes Giving or
  Registration still resolves to Supabase.
- Registration-dependent portal parts (event-scope prayers, event administrators, My
  registrations) are hidden, and no Registration table is read, when the `registration`
  module is off. `/my/serving` returns 404 when Volunteer Scheduling is off.
- Stripe objects and events must now carry a `livemode` equal to the configured mode;
  the previous hard `cs_test_` / `livemode: false` checks are gone. A mismatched event gets
  `400 livemode_mismatch` and is not stored (it was `400 live_mode_disabled`). Every Stripe
  request pins `Stripe-Version: 2025-03-31.basil`. Registration shares this client, so its
  paid checkout also follows the configured mode.
- The online give form is hidden, with a clear message, when Stripe is not configured for
  the current mode. The Billing Portal return URL now comes from `APP_ORIGIN`.
- Year totals on **My giving** bucket by the Stripe payment date in the church time zone and
  are net of refunds; test-mode rows count only on test-mode installations.
- The thank-you page says Stripe emails the receipt (the app never sent one).
- `people.stripe_customer_id` is now a legacy test-mode read fallback; customers live in
  `stripe_customers`, one per person per mode.

### Fixed

- The children's Kiosk tab QR label and hint, and the "My giving" link on the giving thank-you
  page, showed raw dictionary keys. A new test fails when any literal translation key used in
  source is missing from either dictionary.

### Operator impact

- D1 installations: apply the new migration `0039_member_portal_d1.sql` with the normal D1
  migration step before deploying. The migration keeps Member Portal off on an existing
  installation by recording `module.portal = 0` unless a choice is already saved; an
  administrator turns it on in **Settings → Modules**.
- Supabase installations are unaffected by the portal change: it has no PostgreSQL migration.
- **Supabase installations with Giving:** apply PostgreSQL migration
  `0039_giving_production.sql` with the normal Supabase migration step before deploying. It
  adds gift columns (`livemode`, `paid_at`, `refunded_cents`, `stripe_charge_id`), widens the
  gift method and status and recurring interval checks, and adds `stripe_customers`,
  `giving_statement_outbox`, `giving_audit_events`, and fund description / default /
  tax-deductible columns. Existing manual gifts become live; existing Stripe gifts stay test
  (they were test-only) and their `paid_at` is backfilled from `created_at`. Existing
  installations remain in test mode: no behavior changes until you opt into live.
- New variable `STRIPE_LIVE_CONFIRMED` (set to `1` together with `STRIPE_MODE=live`) is the
  explicit live opt-in; `STRIPE_MODE` now accepts `test` or `live`. Setup still provisions test
  mode and preserves a live opt-in when rerun. The webhook endpoint must be created at Stripe
  API version `2025-03-31.basil`; the doctor warns on stored events from another version.
- Update the Stripe webhook endpoint to the twelve events in the go-live checklist
  (`invoice.payment_failed`, `charge.failed`, `charge.dispute.created`, and
  `charge.dispute.closed` are new).
- No new bindings, secrets, or cron triggers. Statement emails ride the existing
  `*/5 * * * *` Supabase schedule.
- Service Planning: apply the new migration `0040_service_planning.sql` with your normal
  migration step before deploying: `npm run db:migrate:remote` on D1 and
  `npm run db:migrate:supabase` on Supabase (numbered `0040` there as well, after Production Giving's
  `0039`). It adds seven
  `planning_*` / `availability_windows` tables with `campus_id`, four default notification
  rules, and registers the new person references with the identity merge inventory. On an
  existing installation it also records `module.planning = 0`, so the module stays off until
  an administrator turns it on in **Settings → Modules**; a fresh installation follows the
  setup choices, and no preset includes Service Planning.
- Service Planning adds the `planning` administrator area, grantable on a person's page.
  Reminder emails use the existing daily reminder cron (`0 13 * * *`).

## [1.4.0] - 2026-11-14

Upgrade notes: [Upgrading 1.3.0 to 1.4.0](docs/upgrade.md#upgrading-130-to-140).

### Added

- Three focused setup presets: `checkin` (People & Households, Children Check-in),
  `volunteer-scheduling` (Volunteer Scheduling, Spiritual Gifts, People & Households), and
  `small-groups` (Groups, Fellowships, People & Households). They run on the default D1
  database and work with the installer's `--preset` flag.
- `npm run onboard -- --preset <key>` opens the browser form with that preset's features
  pre-checked; the form's reset button returns to the same preset.
- `config/editions.json` and `node scripts/editions/render.mjs` describe and render the
  single-feature edition repositories. Each edition is a README and agent guide that installs a
  pinned release of this repository with one preset; editions contain no application code.
  See [`docs/editions.md`](docs/editions.md).

### Operator impact

None for existing installations: no migrations, bindings, secrets, module defaults, or access
rules change. Existing presets keep their module lists. A preset's module list is recorded in
each installation's setup manifest, so the new presets' lists are fixed from this release on.

## [1.3.0] - 2026-11-13

### Added

- `npm run onboard` opens a local browser form for church, nonprofit, or campus identity,
  primary and secondary colors, a PNG/JPEG/WebP logo, language, first administrator,
  initial content, and feature checkboxes. It recommends the D1-backed Website + Community
  selection; Supabase-only modules require an explicit advanced choice. Preferences and
  uploaded logos stay in Git-ignored `.church/` files and can be reopened in later sessions.
- The existing installer accepts `--preferences .church/preferences.json` for both dry-run
  plans and setup. Initial setup applies identity and logo settings and stores brand colors
  locally for design-token generation. README, AGENTS.md, CLAUDE.md, and the setup guide
  describe the browser-first workflow and preference reuse by coding agents.
- Every deployment now serves a generated `/robots.txt` and `/sitemap.xml`. The sitemap
  lists public landing pages for enabled modules and published custom pages in English and
  Chinese with hreflang alternates; robots.txt names the sitemap and disallows admin,
  signed-in, token, kiosk, and API paths. Indexable public pages add Open Graph and Twitter
  card tags, and the home page adds a schema.org `WebSite` description.
- Optional `GOOGLE_SITE_VERIFICATION` and `BING_SITE_VERIFICATION` Worker variables render
  search-console ownership meta tags; malformed values are ignored.

### Changed

- Canonical, hreflang, and Open Graph URLs now use the deployment's `APP_ORIGIN` (falling
  back to the request origin) instead of the build-time `site` in `astro.config.mjs`, so
  each church's pages point at its own domain.
- Refresh npm dependencies, including Astro 7.3.3, React 19.3.0, Tailwind CSS 4.3.3,
  Wrangler 4.135.0, and current compatible adapters, fonts, types, and utilities.
  Replace `@cloudflare/vitest-pool-workers` with its official successor,
  `@cloudflare/vitest-plugin` 1.1.13. Keep TypeScript 6.0.3 and Vitest 4.1.11 because
  the Astro checker and Cloudflare test plugin do not yet support their newer major
  versions. Pin the checker's language server to 2.16.16 to avoid false frontmatter
  parsing errors in 2.17.0; see the
  [dependency compatibility notes](docs/upgrade.md#1-identify-what-will-change).
- Recognize the updated workerd socket-close message in the existing narrowly scoped
  PostgreSQL end-to-end test cleanup filter. Other unhandled errors still fail the suite.

### Upgrade notes

- From 1.2.0, no database migration is added: the latest forward migration remains
  `0038_community_workflows.sql` on both backends. Run `npm ci` and rebuild after pulling
  the dependency refresh. Node.js 22.22.1 remains the minimum runtime. No reseeding,
  bindings, secrets, or deployment procedure changes are needed; follow
  [the upgrade runbook](docs/upgrade.md#upgrading-120-to-130).
- Confirm `vars.APP_ORIGIN` is the domain visitors use: canonical links, `/robots.txt`, and
  `/sitemap.xml` now come from it. Then submit `/sitemap.xml` to search consoles if wanted.
- Onboarding only saves local preferences; it does not create resources or deploy a site.
  Existing installations need no migration, reseeding, new binding, or secret for this
  workflow. Use the existing upgrade/configuration process for subsequent site changes;
  saving new preferences does not overwrite the installed brand.
- Preserve `.church/preferences.json`, its uploaded logo, and `.church/branding.json`
  when moving an organization's build to another machine. Initial setup generates brand
  tokens; `npm run tokens` and production builds regenerate them from the local brand file.
  Organization type and time zone remain preference context for further customization;
  this form does not change the application's scheduling time zone.

### Documentation

- README now leads with what the project is (open-source church management software,
  church CMS, and a self-hosted Planning Center alternative), adds project badges, a
  feature comparison with its current gaps, an FAQ, and a Chinese summary. `package.json`
  gains description, keywords, homepage, repository, and issue links; it stays private.
- Add `llms.txt` and `CITATION.cff` at the repository root, a 1280×640 social preview image
  at `docs/images/social/social-preview.png`, and a "Search engines" section in the
  deployment guide.

### Fixed

- Community workspace entry buttons now persist the selected campus through the existing
  campus switch endpoint, so navigation to fellowships, groups, and workflows keeps its
  context. Workflow save redirects also retain the selected campus, including email links.

## [1.2.0] - 2026-09-15

### Added

- Campus community workspaces can directly manage Groups and member follow-up. Optional
  Fellowships add independent membership, meeting details, a default coordinator, and child
  groups. Existing groups remain directly managed by their campus until explicitly assigned.
- Reusable campus and fellowship workflows provide manual and new-member enrollment,
  assigned steps, due dates, progress notes, completion, cancellation, and reminder controls.
  Members receive a private task workspace. All new interface and email copy is English.
- Cloudflare email reminders use the existing hourly cron and EMAIL binding, with atomic
  delivery claims, failed-send backoff, pause controls, and explicit recovery for uncertain
  delivery. Reminders are disabled unless WORKFLOW_EMAIL_ENABLED=1.

### Upgrade notes

- From 1.1.0, apply all outstanding forward migrations 0027 through 0038 for the selected
  backend before deploying 1.2.0. These include the existing campus, identity, and Planning
  Center updates as well as 0038_community_workflows.sql on D1 and Supabase/PostgreSQL.
- Preserve existing database, R2, authentication secrets, and provider configuration; use
  [the upgrade runbook](docs/upgrade.md). This release does not reseed church data.
- Review [community workflows](docs/features/community-workflows.md) before enabling email.
  Confirm the sending domain, EMAIL_FROM, and APP_ORIGIN. No new cron trigger is required.
- Community administrators need the existing Groups grant. A fellowship coordinator label
  does not grant admin privileges. Identity merges with community references require review.


### Security

- Upgrade Astro, its Cloudflare/React adapters, Wrangler, the Workers test pool,
  and affected transitive dependencies to clear the 13 npm audit findings.
  Keep Vitest on its compatible 4.x release line. Pin native install-script
  approvals for npm 12. Operator impact: run `npm ci`, rebuild, and follow the
  normal deployment process to use the patched packages. No database migration,
  reseeding, secret, or application configuration change is required.

### Changed

- Renewed all 21 core modules with Sanctuary typography, forest-green navigation,
  purpose-specific public/member/admin workspaces, responsive layouts, keyboard
  editor controls, and nine bundled decorative images. English interface and demo
  presentation stay English; Chinese pages retain bilingual support. Existing
  personal names, messages, editor inputs, and authorization boundaries remain.
  README now includes 29 refreshed application screenshots and a repeatable capture
  inventory. No image service or API key is required for the packaged design.
- First setup now describes both starting-content choices explicitly and accepts
  `--no-demo-data` alongside `--demo-data`. Both keep the bundled design; no-demo setup
  retains schema, operational defaults, modules, church settings, and the first admin
  without sample business records. Noninteractive setup still defaults to no demo data.
  New managed initialization records `site.demo_content` without overwriting an existing
  choice. Operator impact: no migration or reseeding is required; neither flag clears an
  existing installation, and existing content remains protected during reruns and feature
  selection changes. Legacy initialized databases retain their absent content marker.
- Setup preserves Wrangler's structured stdout error messages when stderr is empty,
  extracting only the bounded, redacted diagnostic field. This keeps fresh-database
  detection working with JSON command errors without dumping query results or secret
  fields. No dependency change or operator action is required.
- Fresh administrator setup now creates its trusted verified contact and audit
  records atomically, so both demo choices can sign in after member-identity
  migrations. Reruns do not reverify existing or revoked ownership. PostgreSQL
  query compatibility fixes cover child attendance, scoped team scheduling, and
  security contact labels; PostgreSQL identity sessions require UTC as documented.

## [1.1.0] - 2026-08-18

### Added

- Added the optional Learning module on D1 and PostgreSQL for Sunday school, discipleship,
  and similar ministries. Its bilingual authenticated learner pages show provider-authoritative
  course/activity metadata, click-to-load privacy-enhanced YouTube, safe provider files and
  links, due dates, and submitted/returned state; assignments and quizzes remain in the provider.
- Added official Google Classroom OAuth/API support with minimal read-only and notification
  scopes, course mapping, renewable Pub/Sub registrations, authenticated notification receipts,
  bounded scheduled/manual/notification sync, and durable disconnect cleanup.
- Added Church4Christ Learning — Canvas Edition integration through scoped Canvas OAuth/REST and
  signed Live Events. The separately operated derivative is based on Canvas LMS by
  **Instructure, Inc.**, pinned to upstream commit
  `1c9f0bb8013ed69c4f2efe11fd483025469b7e6c`, licensed under GNU AGPL v3, and is not endorsed by
  Instructure, Inc.
- Added bounded provider retry/backoff, fair scheduled scans, fail-closed reconnect state, and
  PII-free structural synchronization logs while preserving the last complete learner snapshot.
- Added an optional Activity Score module on D1 and PostgreSQL with configurable group
  attendance, confirmed serving, registration engagement, and default-disabled Learning
  engagement dimensions; explainable member calculations, coverage, trends, and summary.
- Added the fictional local Genesis 1 Sunday-school demo, bilingual learner/admin screenshots,
  and the gpt-image-2-generated Learning workflow diagram and provenance.

### Security

- Provider credentials use a versioned AES-256-GCM server-side envelope; OAuth state, callbacks,
  notification identity, allowed provider origins, URLs, response sizes, pages, items, elapsed
  time, D1 queries, and provider subrequests fail closed at bounded limits.
- Learning stores only the normalized metadata needed for the hub. Grades and answers are not
  stored; comments, assignment bodies, uploaded files, file bytes, raw provider bodies,
  continuation tokens, and provider credentials never enter learner HTML or Activity Score.
- Google Classroom and Canvas remain provider authoritative. Church4Christ launches provider
  submission UI and never acts as a second gradebook, quiz engine, or file proxy.

### Upgrade notes

- Upgrade 1.0.0 installations by backing up and rehearsing the matched Worker/database/R2 and
  provider configuration in staging, then apply forward migrations `0017_learning.sql` through
  `0026_activity_score_learning.sql` in numeric order on D1 or Supabase/PostgreSQL before
  deploying 1.1.0. Do not rewrite frozen migration history or roll code back alone after `0026`.
- Existing installations must already have `0016_activity_score.sql`; 1.1.0 preserves that
  configuration and extends it only through forward migration `0026_activity_score_learning.sql`.
- Migrations `0017`–`0019` add the provider-neutral Learning graph, bounded sync leases, and URL
  policy fingerprint; `0020`–`0022` add Google OAuth/Pub/Sub receipt lifecycle and cleanup saga;
  `0023`–`0024` add Canvas OAuth/Live Events and cleanup saga; `0025` adds fair scheduling; and
  `0026` adds default-disabled Learning engagement to Activity Score without rewriting `0016`.
- Configure `LEARNING_CREDENTIAL_KEYS` before authorizing either provider. Google and Canvas
  credentials, Pub/Sub resources, Canvas allowed origins, cron verification, retention policy,
  provider disconnect, and the separate Canvas service/source obligations require operator work;
  `npm run doctor -- --strict` does not prove a successful provider round trip.

## [1.0.0] - 2026-08-12

### Added

- Added a canonical People/Household export for admins with full People access. Downloads
  use the exact 18-column create-only importer contract, partition households atomically
  across bounded CSV parts, and fail closed when records require repair.
- Added a separate super-admin-only pastoral-notes export with explicit acknowledgement,
  bounded CSV output, and PII-free `audit_events` records containing only actor, time,
  action kind, and numeric structural counts.
- Added immutable create-only source-column mapping profiles for People CSV imports. The
  workflow detects exact header-order drift, supports explicit constants and enum
  translations, and retains configuration without source rows or samples.
- Added aggregate Service Attendance on D1 and PostgreSQL: authorized staff can record and
  correct adult service totals, derive optional distinct child totals from historical
  check-ins, and download bounded identity-free CSV reports. Groups per-person attendance
  remains separately authorized.
- Added bilingual Newcomer follow-up on D1 and PostgreSQL: a consented public intake form,
  scoped staff queue and actions, exact-match People handoff, and super-admin configuration.
- Added a shared bilingual launch-readiness catalog used by setup, doctor schema v2, and an
  always-on admin checklist. Super-admin manual acknowledgements are versioned, and restore
  drills expire after 90 days.
- Added a fail-closed `v1.0.0` upgrade rehearsal from the immutable historical baseline for
  forward D1 and isolated-schema PostgreSQL migrations.
- Added operator runbooks for reviewing, staging, backing up, applying, verifying, and
  recovering from future upgrades.
- Documented the maintainer-only process for creating v1.0.0 and future releases.

### Changed

- Staging upgrade instructions now require an explicit staging Wrangler environment or
  configuration for both D1 migrations and deployment.

### Fixed

- Corrected contributor guidance to use the project's five current rules consistently.

### Security

- Database export examples keep backups and PostgreSQL credential files outside the
  repository and keep connection URLs and passwords out of `pg_dump` arguments.
- Staging and production upgrade steps require operators to verify the exact non-secret D1 or
  Supabase/Postgres target identifiers before migration.
- Newcomer public rate limits store only keyed hashes and counters, ignore forwarded client
  headers, and fail without writing when the managed rate-limit secret is unavailable.

### Upgrade notes

- Apply forward migration `0011_people_exports.sql` before deploying the pastoral-notes
  export. It creates the `audit_events` table and actor/time index on D1 and
  Supabase/PostgreSQL; audit failures suppress the sensitive CSV.
- Apply forward migration `0012_people_import_mappings.sql` before deploying saved People
  mappings. It creates the bounded `people_import_mappings` profile table on D1 and
  Supabase/PostgreSQL; profiles store headers and mapping configuration, not uploaded rows.
- Apply forward migration `0013_service_attendance.sql` before deploying the Attendance
  admin console. It creates `service_attendance`, `service_type_checkin_events`, and
  `service_checkin_link_state` on both D1 and Supabase/PostgreSQL; no adult roster is stored.
- Apply forward migration `0014_newcomers.sql` before enabling Newcomers. It creates the
  bilingual form configuration, queue, activity, operation receipt, and hashed rate-limit
  tables on both D1 and Supabase/PostgreSQL.
- Apply forward migration `0015_onboarding.sql` before opening the launch checklist. It
  creates versioned manual acknowledgement storage on D1 and Supabase/PostgreSQL.
- Migration files `0001` through `0015` in both `migrations/` and `migrations-supabase/` are
  the frozen `main` baseline. Disposable local/CI databases do not freeze a proposed migration
  before merge, but merge to `main` or use by a persistent/shared/deployed installation does.
  Corrections after that boundary must use a new numbered forward migration.

# Deploying to Cloudflare

This is the full, from-scratch walkthrough to put Church4Christ online on Cloudflare's
platform, with your own domain. The base Worker, D1, and R2 resources can start within free
allowances; production email and usage beyond plan limits can require a paid plan. It takes
most people under an hour the first time. If you would rather have an AI assistant do it,
hand it this file (see the README's "Build it with an AI assistant").

> **Not sure what any of this means?** Read [`cloudflare-setup.md`](./cloudflare-setup.md)
> first — it explains, in plain language, what Cloudflare is, what it costs, and the two
> ways to set it up. Then come back here for the exact commands.

> **Cost (August 2026 snapshot; subject to change).** Workers, D1, and R2 have free
> allowances, but a production deployment is not guaranteed to remain free. Sending email
> to arbitrary recipients currently requires Workers Paid. Check the official
> [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
> and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

> **Choose the setup path before you deploy.** For the recommended guided path, stay on
> this page and run `npm run setup`; it selects D1 for Website / Website + Community and
> Supabase for Full Church or any custom selection with Member Portal, Giving, or
> Registration. The manual reference has an explicit [database fork](#manual-database-fork):
> D1 uses the numbered D1 steps, while Supabase creates only R2 here, completes the
> database steps in [`supabase-setup.md`](./supabase-setup.md), and resumes at email setup.
> There is no automated D1↔Supabase content migration yet.

## Recommended: guided setup

After installing Node.js 22.22.1 or newer and running `npm ci`, run the guided installer
first:

```bash
npm run setup
```

Choose **Deploy**, then Website (8 modules), Website + Community (all 14 D1-compatible
modules), Full Church (all 17), or a custom feature list. Setup selects the database,
creates or imports D1/R2/Hyperdrive resources, writes generated configuration, applies
migrations, stores explicit module settings, and bootstraps the first admin. It prints the
next command, normally `npm run deploy`. Verify readiness at any time with:

```bash
npm run doctor
```

Doctor reports configuration and resource readiness that the installer can inspect. It
does not prove production email delivery, successful sign-in, route behavior, scheduled-job
execution, or backup recovery; verify those outcomes with the go-live checklist below.

Deploying D1 requires a Cloudflare account. Deploying Supabase requires Cloudflare and
Supabase. When a deploy setup must create or recover a Hyperdrive configuration, it refuses
to put the connection URL in Wrangler's child-process arguments unless you explicitly add
`--allow-hyperdrive-secret-in-argv` after reviewing that exposure. Importing an existing
Hyperdrive does not require that consent.

## First deployment versus an upgrade

This walkthrough provisions a new installation. Once an environment contains church data,
uploaded media, custom code, or production configuration, treat the next deployment as an
upgrade: review [`CHANGELOG.md`](../CHANGELOG.md), take verified database and R2 backups,
rehearse the target revision in staging, apply only forward migrations, and test recovery.
Follow the dedicated [`upgrade.md`](./upgrade.md) runbook rather than rerunning setup as an
unreviewed one-click update. Setup can change resources, configuration, schema, module rows,
and administrator state; it does not replace an operator-approved upgrade plan.

## Manual reference and troubleshooting

The remaining commands explain the underlying Cloudflare operations for troubleshooting
or maintaining an installation created by guided setup. They are not a replacement for
setup's module initialization and first-admin bootstrap on a new installation.

## Before you start

You need:

- **[Node.js](https://nodejs.org/) 22.22.1 or newer** and the project installed locally
  with `npm ci`. The Cloudflare CLI, `wrangler`, comes with it.
- A **free Cloudflare account** — sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
- Optionally, a **domain** you want the site to live on (for example `church.yourname.com`).

Authenticate the CLI once:

```bash
npx wrangler login
```

### Manual database fork

- **D1:** continue with step 1 below.
- **Supabase:** do **not** create a D1 database or run the D1 migration in steps 1–4.
  Create only the shared media bucket:

  ```bash
  npx wrangler r2 bucket create church4christ-media
  ```

  Then complete sections 2–5 of [`supabase-setup.md`](./supabase-setup.md#2-create-the-supabase-project)
  for the project, Hyperdrive configuration, Postgres migrations, and session secret.
  Return to this page at [step 5, Set up email](#5-set-up-email), then continue through
  deploy, domain, sign-in, and the go-live checklist. Skip the D1-only backup step 9.

## 1. Create the database (D1) and media bucket (R2) — D1 path only

```bash
npx wrangler d1 create church4christ-db
npx wrangler r2 bucket create church4christ-media
```

The `d1 create` command prints a **`database_id`** — copy it, you need it next.

## 2. Fill in `wrangler.jsonc`

Open `wrangler.jsonc` and:

- Paste your `database_id` in place of `YOUR_D1_DATABASE_ID`.
- Set `vars.APP_ORIGIN` and `vars.EMAIL_FROM` to your own domain (see steps 5 and 6). The
  defaults point at the project's demo domain — change them.
- Leave the `name`, bindings (`DB`, `MEDIA`, `EMAIL`), and cron triggers as they are unless
  you have a reason to rename.

The placeholder IDs and the domain in this file are **safe to commit** — they are not
secrets. (Secrets are set separately in step 4 and never go in this file.)

## 3. Create the database tables

Apply the migrations to your new remote database:

```bash
npm run db:migrate:remote
```

This creates every table. It does **not** load the demo content — a real deployment starts
empty, and you add your church's content through the admin area.

The local `npm run db:seed-media:local` command is only for the developer demo. Production
media starts empty too; admins can upload the homepage hero, event images, ministry covers,
and profile pictures through the admin area or profile pages after the site is live.

### D1 capacity for People CSV imports

The People admin's CSV importer is atomic on both D1 and PostgreSQL: it reparses and
preflights the selected file on the server, then commits every person, household, and
membership together or commits nothing. Do **not** work around a D1 limit by splitting one
request into chunks; the importer intentionally never makes partial commits.

D1 Free currently allows 50 queries per Worker invocation. The largest accepted CSV (200
data rows and up to 100 households) can require about 500 batch statements — up to 200
person inserts, 100 household inserts, and 200 membership inserts — plus the preflight
scans of existing emails and household names. Large D1 imports therefore require a
plan/runtime with a paid-capable per-invocation limit; if the deployment cannot accommodate
the complete preflight and atomic batch, reduce the CSV before retrying. Cloudflare prices
and limits change, so treat the current
[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/) as
authoritative rather than relying on this snapshot.

Saved mapping profiles use forward migration `0012_people_import_mappings.sql`. Profiles
store expected headers and mapping configuration, never uploaded source rows or sample
values. The mapping workflow keeps the same 200-row atomic import boundary, so a D1
deployment that needs large mapped imports must be paid-capable for the required
per-invocation query volume. Smaller imports can fit lower limits; verify the current
Cloudflare limits for the deployed plan instead of assuming profile storage changes the
atomic commit cost.

## 4. Set the session secret

Sessions are signed with `SESSION_SECRET`. Generate a strong random value (32+ bytes) and
store it as a Cloudflare **secret** — never in `wrangler.jsonc` or `vars`:

```bash
# Generate a value:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Store it (paste the value when prompted):
npx wrangler secret put SESSION_SECRET
```

Rotate this secret if it is ever exposed; changing it signs everyone out. See
[`SECURITY.md`](../SECURITY.md).

## 5. Set up email

Church4Christ sends transactional email (sign-in magic links, scheduling requests, the
weekly digest) through the Cloudflare **Email** binding declared in `wrangler.jsonc`
(`send_email`). Before any remote send, put the sender domain on Cloudflare DNS and
[onboard it for Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/)
in the Cloudflare dashboard. The `allowed_sender_addresses` binding option restricts which
From addresses the Worker may use, and `EMAIL_FROM` selects the application's From address;
neither setting onboards or verifies the sending domain. See the official
[send-binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/).

Then choose the path that matches what you are doing:

- **Local development only:** guided Local setup writes `EMAIL_DEV_LOG=1` to `.dev.vars`.
  Messages, including magic links, print in the `npm run dev` terminal and are not sent.
  Do not add this setting to deployed `wrangler.jsonc` configuration.
- **Controlled deployed testing:** after onboarding the sending domain, verify a
  destination address in your Cloudflare account and send only to that address. Cloudflare
  currently does not charge for sends to verified destinations.
- **Production recipients:** after onboarding the sending domain, sending to arbitrary
  addresses currently requires the **Workers Paid** plan. Set
  `allowed_sender_addresses` and `EMAIL_FROM` to an address on that onboarded domain.

These plan rules are an **August 2026 snapshot** and are subject to change. Confirm them on
the official [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) pages.

## 6. Deploy

```bash
npm run deploy
```

This builds the site and pushes the Worker. It prints a `*.workers.dev` URL you can open
right away to confirm it is live.

## 7. Point your own domain at it

Using `church.yunfei-song.com` as the example:

1. Make sure the domain (`yunfei-song.com`) is on your Cloudflare account (add it as a site
   if it is not).
2. In the dashboard, go to **Workers & Pages → church4christ → Settings → Domains & Routes
   → Add → Custom domain**, and enter `church.yunfei-song.com`. Cloudflare creates the DNS
   record and certificate for you.
3. Update `vars.APP_ORIGIN` to `https://church.yunfei-song.com` and `vars.EMAIL_FROM` to
   an address on that domain, then `npm run deploy` again so the running Worker knows its own
   origin (this matters for CSRF checks and absolute links).

## 8. Sign in as the first admin

`npm run setup` creates or promotes the first administrator through the same validated,
idempotent bootstrap path on both databases. Use the email you supplied to setup; do not
insert an admin with ad-hoc SQL. Open `https://church.yunfei-song.com/en/signin`, enter that
email, and request a link.
The magic link is delivered by email. For a local run only, `EMAIL_DEV_LOG=1` prints it in
the `npm run dev` terminal instead. Click it and you are in as an admin. From there, set
your church's name, address, service times, and theme in **Settings**, and start adding
content.

## 9. (Optional, D1 only) Enable nightly backups

The nightly D1 → R2 backup is off until you configure it. To turn it on:

1. Uncomment and fill `vars.CF_ACCOUNT_ID` and `vars.D1_DATABASE_ID` in `wrangler.jsonc`.
2. Create a **scoped** Cloudflare API token with permission to export that one D1 database,
   and store it as a secret:

   ```bash
   npx wrangler secret put D1_EXPORT_TOKEN
   ```

3. `npm run deploy`. Each night the Worker writes `backups/YYYY-MM-DD.sql` into your R2
   bucket (reachable only by you — never through the public `/media` route). If any of the
   three values is missing, the backup logs a line and skips, so nothing breaks.

The backup file contains **member data** (names, emails, phone numbers). Keep the export
token scoped to the minimum and treat the bucket as private — see [`SECURITY.md`](../SECURITY.md).

## 10. (Optional) Put Cloudflare Access in front of `/admin`

For an extra layer, you can require Cloudflare **Access** (Zero Trust) sign-in before anyone
can even reach `/admin`, on top of the app's own magic-link auth. This is defense in depth
and entirely optional; it does not replace application security, dependency maintenance,
backups, or monitoring. Configure it in the Cloudflare Zero Trust dashboard as a
self-hosted application covering the `/admin*` path.

![Go-live proceeds from setup and doctor through deployment, domain and HTTPS, email and first-admin checks, then a backup restore drill and monitoring; each operator-managed step must be verified](./images/diagrams/go-live-readiness.png)

## Go-live checklist

Before announcing the site, collect evidence for every item that applies to the modules
you enabled:

- **Health:** request `https://your-domain/healthz` and confirm a `200` response with
  `{"ok":true}`.
- **First administrator:** request the first admin's magic link from the deployed sign-in
  page, receive it through the production email path, open it, and confirm the admin home
  loads.
- **Production email:** send a representative transactional message to an allowed real
  recipient and confirm delivery rather than relying on the local terminal email log.
- **Routes:** open the enabled public and admin routes that the launch depends on using the
  final domain; confirm disabled modules do not appear as enabled navigation.
- **Schedules:** confirm the deployed cron triggers match the selected database and
  enabled modules, then inspect a real invocation or controlled test in Worker logs.
- **Backup artifact:** record the location and timestamp of a recent D1 export or Supabase
  backup, plus the separate plan for uploaded R2 media.
- **Restore drill:** restore that artifact into a non-production environment and verify
  representative records and media references before depending on it for recovery.
- **Monitoring:** configure a named owner and notifications for Worker, email, scheduled
  job, and backup failures, then confirm a test notification reaches that owner.

## Keeping it running

- **Redeploy reviewed application-only changes** with `npm run deploy`. For a source upgrade,
  use [`upgrade.md`](./upgrade.md): inspect operator impact, back up state, rehearse in staging,
  apply the selected backend's forward migrations, deploy, and verify.
- **Deployment is intentionally manual.** This public repo's CI builds and tests every
  change but never deploys — so no Cloudflare credentials ever live in a public repo. If
  you want push-to-deploy, keep a **private** copy of the repo and add a deploy step there
  with a scoped `CLOUDFLARE_API_TOKEN` secret; your keys stay off the public internet.
- **Update dependencies** periodically and run `npm audit` (see [`SECURITY.md`](../SECURITY.md)).
- **Monitor and recover:** review Worker and email failures, verify scheduled backups, keep
  an off-site copy where appropriate, and rehearse restores before an incident.
- **Never commit** `.dev.vars` or any secret — verify before every commit.

# Supabase setup — Portal, Giving, and Registration (Stripe Preview/test only)

Setup is capability-driven: selections among the 14 D1-compatible modules choose D1 unless
you explicitly override the backend. **Member Portal**, **Giving**, and **Registration**
require Postgres, so setup selects **Supabase** when any of those three modules is enabled.
Stripe support in this repository is **Preview/test-only**: the setup accepts test keys and
the runtime rejects live-mode events. It is not a production payment path. Production
email remains on the Cloudflare Email binding. Before remote sending, the sender domain
must use Cloudflare DNS and be
[onboarded for Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/);
arbitrary recipients then require the current Workers Paid plan.
`allowed_sender_addresses` / `EMAIL_FROM` configure the
[binding](https://developers.cloudflare.com/email-service/configuration/send-bindings/)
and From address but do not perform domain onboarding.

Start with the guided installer; it asks for features before choosing a database:

```bash
npm run setup
```

Local Supabase requires a local Postgres/Supabase database or a hosted Supabase project.
Deploying requires both Cloudflare and Supabase. There is no automated D1↔Supabase content
migration, so this guide does not promise a lossless backend switch for an existing site.

> **New to all of this?** Read [`cloudflare-setup.md`](./cloudflare-setup.md) first — it
> explains, in plain language, what Cloudflare is and how its plan allowances work. This page
> assumes you have already been through [`deploy.md`](./deploy.md) once, or are comfortable
> with a terminal.

> **Prefer to have an AI assistant do it?** Hand it this file. A good first thing to say:
> *"Read `docs/supabase-setup.md`, then run the guided setup for Full Church on Supabase.
> Ask me for anything you need — my Supabase
> connection string, my Stripe keys — one question at a time, and run the commands for me."*

---

## 1. Which database should I pick?

Both offer a Free plan for eligible usage. Choose Supabase to enable Member Portal, Giving,
or Registration; the other 14 modules work on either database.

| | **D1** (default) | **Supabase** (Postgres) |
|---|---|---|
| **Extra accounts to create** | None — just Cloudflare | A Supabase account |
| **Setup effort** | Simplest (this is what `deploy.md` covers) | A few more steps (this page) |
| **Giving — offline/manual ledger** | Not available | **Implemented** |
| **Giving — Stripe online/recurring** | Not available | **Preview/test-only**; live payments unavailable |
| **Registration — free events** | Not available | **Implemented** |
| **Registration — paid via Stripe** | Not available | **Preview/test-only**; live payments unavailable |
| **Member Portal** (household, groups, calendar, prayer) | Not available | **Available** |
| **Other 14 modules** | Yes | Yes |
| **Backups** | Optional nightly D1 → R2 copy you configure (`deploy.md` step 9) | Free: manual dumps; Pro: automatic daily backups with 7-day retention as of August 2026 |
| **Plan considerations** | Cloudflare allowances and email plan rules apply | Supabase limits, continuity needs, and Cloudflare/email plan rules all apply |

As an **August 2026 snapshot**, Supabase Free is suitable for evaluation or a small active
site that remains within its limits. A project with low activity over about seven days may
be paused. Free does not include automatic daily backups, so run `supabase db dump`
regularly, keep encrypted/off-site copies, and perform restore drills. Pro currently
includes daily backups with seven-day retention. Choose a production plan based on the
church's continuity and recovery risk, not only expected database size. Terms can change;
check [Supabase pricing](https://supabase.com/pricing),
[database backups](https://supabase.com/docs/guides/platform/backups), and
[Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).

Member Portal, Giving, and Registration are **force-disabled on D1**, even if legacy
settings say they are on. New setup writes explicit selected settings for all 17 modules.

---

## Manual reference and troubleshooting

The guided installer performs the database and configuration work below. Keep these steps
as a reference for diagnosing an existing installation.

## 2. Create the Supabase project

1. Sign up for a free account at [supabase.com](https://supabase.com/) and click **New
   project**.
2. Give it a name (for example `church4christ`), pick a region near your church, and — this
   is important — **set a database password and write it down.** You will paste it into a
   connection string in the next step, and Supabase does not show it again.
3. Wait a minute for the project to finish provisioning.
4. Find your **connection string**: go to **Project Settings → Database → Connection
   string**, and choose the **Session pooler** tab. It looks like this:

   ```
   postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres
   ```

   Replace `[YOUR-PASSWORD]` with the password from step 2. Keep this whole string handy —
   you use it in steps 3 and 4. **Use the Session pooler string** (port `5432`), not the
   direct connection or the transaction pooler: it is the one Cloudflare Hyperdrive and the
   migration script both work with reliably.

---

## 3. Connect Cloudflare to Supabase (Hyperdrive)

Cloudflare **Hyperdrive** sits between your Worker and Supabase, pooling connections and
caching queries so a serverless Worker can talk to Postgres quickly. You create it once and
paste its id into your config.

Guided setup normally creates or imports this resource. Creating or recovering it requires
explicit `--allow-hyperdrive-secret-in-argv` consent because Wrangler receives the database
URL in its child-process arguments; importing an existing Hyperdrive does not.

```bash
npx wrangler hyperdrive create church4christ-db \
  --connection-string="postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
```

Use your own Session pooler string from step 2 (with the real password). The command prints
an **`id`** — copy it.

Now open `wrangler.jsonc` and make three changes:

1. **Uncomment the `hyperdrive` line and paste your id** in place of `YOUR_HYPERDRIVE_ID`:

   ```jsonc
   "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "PASTE_YOUR_HYPERDRIVE_ID_HERE" }],
   ```

   Leave the `"binding": "HYPERDRIVE"` name exactly as it is — the app looks for that name,
   and deploying with `DB_BACKEND=supabase` but no `HYPERDRIVE` binding fails on purpose.

2. **Switch the backend** by changing `DB_BACKEND` from `"d1"` to `"supabase"`:

   ```jsonc
   "DB_BACKEND": "supabase"
   ```

3. **Replace the D1 cron list with the Supabase cron list:**

   ```jsonc
   "triggers": {
     "crons": ["0 13 * * *", "0 14 * * 4", "0 * * * *", "*/5 * * * *"]
   },
   ```

   This preserves daily serving reminders, the weekly serving digest, and hourly group
   attendance, then adds the Supabase Preview/test-only Stripe recovery pass. Remove the
   D1-only nightly backup cron `0 9 * * *`; do not keep it alongside the five-minute
   recovery cron.

All three changes live in `wrangler.jsonc`, which is **safe to commit** — the Hyperdrive id
and cron strings are not secrets, and your database password stays inside the Hyperdrive
config in your Cloudflare account, not in this file.

---

## 4. Create the tables

Point the migration script at your Supabase connection string. It applies every file in
`migrations-supabase/` once and tracks what it has run, so it is safe to run again.

```bash
SUPABASE_DB_URL="postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres" \
  npm run db:migrate:supabase
```

It prints `applying …` for each new file and finishes with `migrations up to date`. This
creates every table — the same content tables as D1, **plus** the Portal, Giving, and
Registration tables. It does **not** load any content; a real deployment starts empty and
you add your church's content through the admin area.

> The script reads `SUPABASE_DB_URL` (or `DATABASE_URL` if you prefer that name). If it
> prints `set SUPABASE_DB_URL (or DATABASE_URL)`, you forgot the variable. If it reports an
> SSL error, append `?sslmode=require` to the end of the connection string.

**Optional — load the demo content.** To fill a *test* project with the same realistic
sample data as the local demo (sample people, households, funds, gifts, and a couple of
registration events), run the seed. **Skip this for a real church deployment** — you do not
want demo people in your live database.

```bash
SUPABASE_DB_URL="postgresql://…pooler.supabase.com:5432/postgres" npm run db:seed:supabase
```

---

## 5. Set your secrets

Secrets never go in `wrangler.jsonc`. The manual session-secret command below prompts you
to paste the value; guided setup imports Stripe test credentials separately in step 7.

```bash
# Session signing key (same as the D1 setup). Generate a strong random value:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put SESSION_SECRET

# Stripe test credentials are imported by guided setup; see step 7.
```

If you already deployed on D1, `SESSION_SECRET` is set and you can leave it. Stripe is
available only on Supabase and only in test mode. Import its two test credentials through
guided setup after step 7. Until they are stored, the online giving form is inert and paid
registration cannot take money — everything else works. Redeploy after setting them:

```bash
npm run deploy
```

---

## 6. Sign in as the first admin

`npm run setup` creates or promotes the first administrator through the validated bootstrap
path. Do not create this privileged identity with ad-hoc SQL. Open
`https://<your-site>/en/signin`, enter the setup email, request a link, and click it —
you are in as an admin.

To delegate payment work without making someone a full admin, open their profile in
`/admin/people` and turn on **Payment operations (Giving and paid Registration)**. This
grants giving administration plus Stripe replay/dismiss, verified-session attachment,
reconciliation, and explicit pending-registration cancellation. Grant it only to someone
trusted with both kinds of payment operation.

---

## 7. Stripe Preview setup (test-only, for Giving and Registration)

This integration is for previewing and testing the payment flows only. It accepts Stripe
test-mode credentials and does not support live production payments. In test mode, card
details are handled by **Stripe**, not by this application.

1. **Create a Stripe account** at [stripe.com](https://stripe.com/) and stay in **test
   mode** (the toggle in the dashboard) while you try things out — test-mode keys and
   webhooks are completely separate from live ones, so you can experiment safely.

2. **Get your test secret key.** In the Stripe dashboard → **Developers → API keys**, copy
   the test **Secret key** beginning `sk_test_…`. Church4Christ intentionally rejects every
   other prefix.

3. **Add the webhook endpoint.** In **Developers → Webhooks → Add endpoint**, set the
   endpoint URL to:

   ```
   https://<your-site>/api/stripe/webhook
   ```

   Subscribe it to exactly these eight events (this one endpoint serves both Giving and
   Registration — each event tells the app what happened):

   - `checkout.session.completed` — a card gift or a paid registration succeeded
   - `checkout.session.expired` — someone abandoned a registration checkout; frees the seat
   - `checkout.session.async_payment_succeeded` — delayed payment succeeded; fulfills the gift or registration
   - `checkout.session.async_payment_failed` — delayed registration payment failed; frees the seat
   - `invoice.paid` — a recurring gift renewed
   - `charge.refunded` — a gift was refunded
   - `customer.subscription.updated` — a recurring gift's status changed
   - `customer.subscription.deleted` — a recurring gift was canceled

   After creating the test endpoint, Stripe shows a **Signing secret** (`whsec_…`).

4. **Import both values in one setup run.** Use the dedicated one-shot environment names:

   ```bash
   CHURCH_SETUP_STRIPE_SECRET_KEY="sk_test_…" \
   CHURCH_SETUP_STRIPE_WEBHOOK_SECRET="whsec_…" \
   npm run setup
   ```

   Setup validates the pair before making changes, registers both values for redaction,
   and stores them under the runtime secret names automatically. Do not expose them as
   ambient `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` inputs to setup. A partial pair
   or a live key is rejected before local or deployed configuration is changed.

5. **Turn on the Customer Portal.** In **Settings → Billing → Customer portal**, activate
   it and save. This is what powers the **Manage** button on a member's *My giving* page,
   where they can update their card or cancel a recurring gift themselves.

6. **Choose your currency (optional).** Gifts default to US dollars. To use another
   currency, sign in as an admin and set the `giving.currency` site setting to its
   three-letter code (for example `cad` or `eur`).

7. **Keep test mode visible.** The operations page at `/admin/stripe-events` labels every
   screen and action **Stripe test mode** and provides no live-mode switch. Even when a
   live event is separately signed with the configured webhook secret, the endpoint returns
   exactly `400 live_mode_disabled` before durable storage.

The generated Supabase Worker runs webhook-inbox and pending-Checkout recovery on
`*/5 * * * *` (every five minutes). The page above gives admins and finance users bounded,
audited recovery controls without rendering raw webhook payloads, Checkout request JSON,
customer email, secrets, or Checkout URLs. D1 does not support Giving, Registration, Stripe
operations, or this recovery schedule.

See [`docs/features/giving.md`](./features/giving.md) and
[`docs/features/registration.md`](./features/registration.md) for how each module works
day to day.

---

## 8. Optional: reconciliation (Stripe FDW)

Once giving is enabled, you can turn on the **Reconcile** page (`/admin/giving/reconcile`),
which cross-checks your local ledger against Stripe and flags any drift — a gift Stripe has
but your ledger is missing, or the reverse. This is an optional audit convenience for the
Preview/test-mode checkout flow; without it, test checkouts still work but are not
cross-checked through the Reconcile page. It does not make the payment path live-ready.

It uses Supabase's **Stripe Foreign Data Wrapper** to read your Stripe data read-only. The
project ships the setup SQL as an example file:
[`migrations-supabase/9000_stripe_fdw.sql.example`](../migrations-supabase/9000_stripe_fdw.sql.example).
The `.sql.example` suffix keeps it out of the automatic migration runner on purpose — you
apply it by hand, once:

1. Open the Supabase dashboard → **SQL editor**.
2. Follow the numbered steps inside the file. Use a Stripe **restricted, read-only** key
   (read access to Checkout Sessions, PaymentIntents, Charges, and Subscriptions).
3. The key is stored encrypted in **Supabase Vault**, never left in plain SQL — run step 3
   of the file on its own first, copy the returned secret id, and paste it into step 4
   before running the rest.

The reconcile page auto-detects the `stripe` schema and lights up on its next load — no
redeploy needed. Follow Supabase's own guide exactly:
[Supabase Stripe wrapper docs](https://supabase.com/docs/guides/database/extensions/wrappers/stripe).

---

## 9. Local development

To run the Supabase backend on your own computer, start a local Postgres (or use a hosted
Supabase project), export its URL as `SUPABASE_DB_URL`, and run `npm run setup`. The setup
handoff prints the canonical host variable required to start Wrangler.

1. **Start a local Postgres** (Docker is easiest):

   ```bash
   docker run -d --name church-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
   ```

2. **Run guided local setup** with `SUPABASE_DB_URL` exported. It writes the local Hyperdrive
   binding and initializes the selected modules and first admin.

   ```bash
   export SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/postgres
   npm run setup
   ```

3. **Tell the dev server to use your local Postgres.** Export this in the same shell you run
   `npm run dev` from (not `.dev.vars` — wrangler needs to see it before the dev server boots):

   ```bash
   export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://postgres:postgres@localhost:5432/postgres
   ```

   That variable points the `HYPERDRIVE` binding at your local database, so you do **not** need
   a real Hyperdrive id for local dev.

4. **Manual migration/seed troubleshooting:**

   ```bash
   SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/postgres npm run db:migrate:supabase
   SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/postgres npm run db:seed:supabase
   ```

5. **Run it:** `npm run dev`, then open the address it prints (usually
   `http://localhost:4321`). Member Portal, Giving, and Registration now appear, backed by
   your local Postgres.

6. **Testing Stripe locally (optional).** Put your test keys in `.dev.vars`
   (`STRIPE_SECRET_KEY=sk_test_…`), and use the [Stripe CLI](https://stripe.com/docs/stripe-cli)
   to forward webhooks to your dev server:

   ```bash
   stripe listen --forward-to localhost:4321/api/stripe/webhook
   ```

   `stripe listen` prints a `whsec_…` signing secret — set that as `STRIPE_WEBHOOK_SECRET`
   in `.dev.vars` for the session.

Never commit `.dev.vars` — it is gitignored for a reason. See [`SECURITY.md`](../SECURITY.md).

---

## 10. What stays on Cloudflare

Switching the database to Supabase moves **only your tables**. Everything else about the
site still runs on Cloudflare, exactly as `deploy.md` describes:

- **The website itself** — still a single Cloudflare **Worker**.
- **R2 media** — images you upload in the admin area still live in your Cloudflare **R2**
  bucket (the `MEDIA` binding). Supabase holds no files, only data. The local D1 demo media
  seed is separate from the Supabase data seed; for a real church, upload images through
  the admin and profile pages after launch.
- **Email** — sign-in links, volunteer reminders, and the weekly digest still send through
  the Cloudflare **Email** binding. Any remote send first requires a sender domain on
  Cloudflare DNS that has been onboarded for Email Sending. Verified destinations support
  controlled testing; arbitrary recipients currently require Workers Paid.
  `allowed_sender_addresses` / `EMAIL_FROM` configure the binding and From address but do
  not onboard the domain. See [Email Sending setup](https://developers.cloudflare.com/email-service/get-started/send-emails/)
  and [send-binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/).
  `EMAIL_DEV_LOG=1` remains a terminal-only local-development aid.
- **Scheduled jobs (crons)** — daily serving reminders, the weekly serving digest, and
  hourly group-attendance mail use the shared Cloudflare schedules. Generated Supabase
  configuration also runs the Preview/test-only Stripe inbox and Checkout recovery every
  five minutes; payment processing honors the enabled Giving and Registration modules.
- **Hyperdrive** — lives in your Cloudflare account and is what connects the Worker to
  Supabase.

**Backups.** The nightly **D1 → R2** backup (`deploy.md` step 9) is a D1-only feature — it
does not run on the Supabase backend, so leave `CF_ACCOUNT_ID`, `D1_DATABASE_ID`, and the
`D1_EXPORT_TOKEN` secret unset. Supabase Free does not include automatic daily backups:
schedule regular `supabase db dump` exports, store copies off-site, protect them as member
data, and test restoration. As of August 2026, Supabase Pro includes daily backups retained
for seven days; evaluate paid plans and optional recovery features against acceptable data
loss and downtime. Recheck [pricing](https://supabase.com/pricing),
[backup behavior](https://supabase.com/docs/guides/platform/backups), and
[Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
because plan terms are subject to change.

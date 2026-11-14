# Supabase setup — Giving and Registration (Stripe test and live)

Setup is capability-driven: selections among the 20 D1-compatible modules (including
**Member Portal**) choose D1 unless you explicitly override the backend. **Giving** and
**Registration** require Postgres, so setup selects **Supabase** when either is enabled.
Stripe runs in **test mode by default**: the installer accepts test keys, and live mode is a
separate, explicit opt-in described in [section 7](#7-stripe-setup-and-go-live-giving-and-registration).
Production email remains on the Cloudflare Email binding. Before remote sending, the sender domain
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

Use **UTC for PostgreSQL sessions**, including a locally hosted test database. Identity
approval timestamps are stored as UTC text and the current database guards compare them
with the session clock. Check `SHOW timezone;` with the application connection. If needed,
set the application's database or connection role to UTC and reconnect before using
identity approval/recovery. The church's displayed service dates still use the site's
time-zone rules; they are separate from this database requirement.

> **New to all of this?** Read [`cloudflare-setup.md`](./cloudflare-setup.md) first — it
> explains, in plain language, what Cloudflare is and how its plan allowances work. Guided
> setup does not require reading the manual deployment sequence first. If you are tracing
> the underlying commands, start at the deployment guide's explicit
> [manual database fork](./deploy.md#manual-database-fork).

> **Prefer to have an AI assistant do it?** Hand it this file. A good first thing to say:
> *"Read `docs/supabase-setup.md`, then run the guided setup for Full Church on Supabase.
> Ask me for anything you need — my Supabase
> connection string, my Stripe keys — one question at a time, and run the commands for me."*

---

## 1. Which database should I pick?

Both offer a Free plan for eligible usage. Choose Supabase to enable Giving or Registration (and the
Registration-dependent parts of Member Portal); the other 19 modules work on either database.

| | **D1** (default) | **Supabase** (Postgres) |
|---|---|---|
| **Extra accounts to create** | None — just Cloudflare | A Supabase account |
| **Setup effort** | Simplest (this is what `deploy.md` covers) | A few more steps (this page) |
| **Giving — offline/manual ledger** | Not available | **Implemented** |
| **Giving — Stripe online/recurring** | Not available | **Implemented** — test mode by default; live mode after the go-live checklist |
| **Registration — free events** | Not available | **Implemented** |
| **Registration — paid via Stripe** | Not available | **Implemented** — shares the same Stripe mode; verify with the checklist before live use |
| **Member Portal** (household, groups, calendar, prayer) | **Available** (without event prayers, event admins, or My registrations) | **Available** (complete) |
| **Other 19 modules** | Yes | Yes |
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

Giving and Registration are **force-disabled on D1**, even if legacy
settings say they are on. New setup writes explicit selected settings for all 22 modules.

---

## Manual reference and troubleshooting

The guided installer performs the database and configuration work below. Keep these steps
as a reference for diagnosing an existing installation. The shared Cloudflare Worker still
needs R2 media storage: the [manual database fork](./deploy.md#manual-database-fork) creates
only that bucket, sends you through sections 2–5 here, and tells you exactly where to resume
the shared email and deployment steps. Do not run the deployment guide's D1 create,
migration, or D1-backup steps for this backend.

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

Now open `wrangler.jsonc` and make four changes:

1. **Remove the entire `d1_databases` block.** The Supabase Worker does not use a `DB`
   binding, and leaving the sample D1 placeholder in the deployed configuration can make
   Wrangler validate a database that this path never created.

2. **Uncomment the `hyperdrive` line and paste your id** in place of `YOUR_HYPERDRIVE_ID`:

   ```jsonc
   "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "PASTE_YOUR_HYPERDRIVE_ID_HERE" }],
   ```

   Leave the `"binding": "HYPERDRIVE"` name exactly as it is — the app looks for that name,
   and deploying with `DB_BACKEND=supabase` but no `HYPERDRIVE` binding fails on purpose.

3. **Switch the backend** by changing `DB_BACKEND` from `"d1"` to `"supabase"`:

   ```jsonc
   "DB_BACKEND": "supabase"
   ```

4. **Replace the D1 cron list with the Supabase cron list:**

   ```jsonc
   "triggers": {
     "crons": ["0 13 * * *", "0 14 * * 4", "0 * * * *", "15,45 * * * *", "*/5 * * * *"]
   },
   ```

   This preserves daily serving reminders, the weekly serving digest, and hourly group
   attendance, then adds the Supabase Stripe recovery pass (which also sends queued giving statements). Remove the
   D1-only nightly backup cron `0 9 * * *`; do not keep it alongside the five-minute
   recovery cron.

All four changes live in `wrangler.jsonc`, which is **safe to commit** — the Hyperdrive id
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
creates every table — the same content tables as D1, **plus** the Giving and
Registration tables and the Portal's event administrators. It does **not** load any content; a real deployment starts empty and
you add your church's content through the admin area.

Learning works on this backend with the same provider/privacy boundary as D1. Version 1.1.0
requires the complete portable `0017_learning.sql` through
`0026_activity_score_learning.sql` sequence and the shared `15,45 * * * *` cron shown above.
Enabling Learning does not authorize Google Classroom or Canvas; complete the exact credential
key, OAuth, notification, budget, retention, and disconnect runbook in
[`deploy.md`](./deploy.md#learning-module-and-shared-credential-key-ring). Church4Christ Learning
— Canvas Edition remains a separate service/deployment and is not stored inside this Supabase
project.

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
registration cannot take money — everything else works.

For the manual troubleshooting sequence, stop here and return to
[`deploy.md` step 5](./deploy.md#5-set-up-email). That shared sequence configures email,
deploys the Worker, connects the domain, and verifies sign-in. The R2-only creation command
comes before this page in the deployment guide's manual database fork.

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

## 7. Stripe setup and go-live (Giving and Registration)

Stripe owns the payment page, card and bank details, receipts, the Billing Portal,
refunds, and disputes. This application stores only amounts, funds, dates, status, and
Stripe ids. Both Giving and Registration use the same Stripe mode (`STRIPE_MODE`).

### Setting up Stripe for a church or nonprofit

Stripe setup is mostly filling in forms. You need no code and no Stripe developer
experience. Most of the work is done once in Stripe's own dashboard, and this
project's installer imports the two values it needs. At a high level:

1. **Create a free Stripe account** at
   [dashboard.stripe.com/register](https://dashboard.stripe.com/register). You can explore
   test mode right away, before giving Stripe any business details.
2. **Activate the account for real payments** by entering your organization's legal name,
   EIN or other tax number, address, a representative, and the bank account that receives
   donations. See Stripe's guide,
   [Activate your account](https://docs.stripe.com/get-started/account/activate).
3. **Ask Stripe for the nonprofit fee discount** if you qualify. Stripe offers lower
   processing fees to registered nonprofits in supported countries whose Stripe volume is
   at least 80% tax-deductible donations. You request it from Stripe support with your
   account ID and tax documents, such as your IRS 501(c)(3) letter. See
   [Fee discount for nonprofit organizations](https://support.stripe.com/questions/fee-discount-for-nonprofit-organizations)
   and [Stripe for nonprofits](https://stripe.com/industries/nonprofits).
4. **Turn on donor receipts and the donor portal** in the Stripe dashboard:
   [email receipts](https://docs.stripe.com/receipts) and the
   [customer portal](https://docs.stripe.com/customer-management/activate-no-code-customer-portal),
   which donors use to change or cancel recurring gifts.
5. **Optional: bank (ACH) giving.** Lower-fee bank payments for larger gifts are
   available through Stripe's
   [ACH Direct Debit](https://docs.stripe.com/payments/ach-direct-debit); Checkout offers it
   automatically once it is enabled.
6. **Connect Church4Christ**: copy an [API key](https://docs.stripe.com/keys), add one
   [webhook endpoint](https://docs.stripe.com/webhooks), and give both to the installer, as
   shown in 7a. Rehearse with [Stripe's test cards](https://docs.stripe.com/testing), then
   follow the go-live checklist in 7b.

Stripe's eligibility rules and fees can change, so confirm the current terms on the linked
Stripe pages. Stripe's help article
[How to accept donations through Stripe](https://support.stripe.com/questions/how-to-accept-donations-through-stripe)
gives the same overview in Stripe's own words.

### 7a. Start in test mode

1. **Create a Stripe account** at [stripe.com](https://stripe.com/) and stay in **test
   mode** (the dashboard toggle). Test and live keys, webhooks, and customers are
   completely separate.
2. **Copy the test secret key** (`sk_test_…`) from **Developers → API keys**.
3. **Add a test webhook endpoint** (**Developers → Webhooks → Add endpoint**) at
   `https://<your-site>/api/stripe/webhook`, with **API version `2025-03-31.basil`**, and the
   events listed in [7c](#7c-the-webhook-endpoint). Copy its signing secret (`whsec_…`).
4. **Import both values in one setup run:**

   ```bash
   CHURCH_SETUP_STRIPE_SECRET_KEY="sk_test_…" \
   CHURCH_SETUP_STRIPE_WEBHOOK_SECRET="whsec_…" \
   npm run setup
   ```

   Setup validates the pair, registers both values for redaction, stores them under the
   runtime secret names, and writes `STRIPE_MODE=test` into the generated configuration.
   A partial pair or a live key is rejected by this setup input.
5. **Choose your currency (optional).** Gifts default to US dollars; set the
   `giving.currency` site setting to a three-letter code (for example `cad`).

### 7b. Go-live checklist

Do these in order. Nothing here is proven by the repository's tests; confirm each in Stripe.

1. **Finish a test-mode rehearsal:** a card gift, an ACH gift, a recurring gift, a portal
   change, a refund, and a statement preview.
2. **Drain Registration checkout requests.** Open `/admin/stripe-events` in test mode and
   resolve every request still in **creating** (or **attached**) — reconcile it, or cancel the
   pending registration. A request created with a test key cannot complete under a live key.
3. **Activate your Stripe account** for live payments (business details, bank account).
4. **Create the live webhook endpoint** in Stripe's live mode at
   `https://<your-site>/api/stripe/webhook`, **API version `2025-03-31.basil`** (the version
   this release pins), subscribed to the exact events in 7c. Copy its live `whsec_…`.
   The doctor warns when stored events were delivered at a different version.
5. **Create a live key:** a standard secret key (`sk_live_…`) or, preferably, a
   **restricted key** (`rk_live_…`); see the permission list in 7d.
6. **Enable Stripe customer receipt emails** (**Settings → Customer emails**): "Successful
   payments", plus invoice/receipt emails for subscriptions, and "Refunds". The app sends
   no per-payment receipt; one-time gifts also pass the donor's email as the receipt
   address.
7. **Configure the Billing Portal** (**Settings → Billing → Customer portal**). Allow donors to
   **update the amount** (quantity/price change **only within the giving product**), **update
   the payment method**, and **cancel the subscription**; do not allow other products,
   plan switches to other intervals, or promotion codes. Turn on dunning emails for failed
   recurring payments (**Settings → Billing → Subscriptions and emails**), since the app sends
   none.
8. **Enable the payment methods** you want in **Settings → Payment methods** (cards,
   wallets, and ACH Direct Debit `us_bank_account`). Checkout offers whatever is enabled.
9. **Store the live secrets and opt in.** Store the live key and live webhook secret as the
   Worker secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (for example
   `npx wrangler secret put STRIPE_SECRET_KEY`), then set both variables in the generated
   `wrangler.jsonc` `vars`:

   ```jsonc
   "STRIPE_MODE": "live",
   "STRIPE_LIVE_CONFIRMED": "1"
   ```

   `STRIPE_LIVE_CONFIRMED=1` is the explicit opt-in: live mode without it never uses a live
   key and the webhook rejects events. Rerunning setup preserves this opt-in; it will not
   revert you to test mode. Deploy.
10. **Verify with a small live gift.** Give a small real amount, confirm it appears as a live
    ledger row, that Stripe's receipt arrives, then refund it in Stripe and confirm the ledger
    shows the refund. Run `npm run doctor` and confirm there are no Stripe warnings.

### 7c. The webhook endpoint

One endpoint serves Giving and Registration. Subscribe it to exactly these twelve events:

| Event | Why |
| --- | --- |
| `checkout.session.completed` | A gift or paid registration succeeded (or an ACH gift is pending) |
| `checkout.session.expired` | An abandoned registration checkout frees its seat |
| `checkout.session.async_payment_succeeded` | A delayed payment (ACH) settled |
| `checkout.session.async_payment_failed` | A delayed payment failed |
| `invoice.paid` | A recurring gift renewed |
| `invoice.payment_failed` | A recurring payment failed (marks the gift past due; Stripe emails the donor) |
| `charge.refunded` | A refund, partial or full |
| `charge.failed` | A bank debit failed or was returned after being recorded |
| `charge.dispute.created` | A dispute was opened |
| `charge.dispute.closed` | A dispute was won or lost |
| `customer.subscription.updated` | A portal change to amount, interval, or status |
| `customer.subscription.deleted` | A recurring gift was canceled |

An event whose mode (`livemode`) differs from the configured mode is rejected: a test event
under live mode, or a live event under test mode, returns `400 livemode_mismatch` and is not
stored. **Replay, reconcile, and attach** on `/admin/stripe-events` work in either configured
mode and are labeled with it.

### 7d. Restricted key permissions (`rk_live_`)

If you use a restricted key, grant only: **Checkout Sessions: Write**, **Customer portal
sessions (Billing portal): Write**, **Customers: Read**, **Subscriptions: Read**, **Invoices:
Read** (includes invoice payments), and **Charges and PaymentIntents: Read**. A missing
permission appears as a 403 in the Stripe request log; add it and retry.

### 7e. Switching modes, key rotation, and runbooks

- **Switching between test and live.** Set `STRIPE_MODE` (and `STRIPE_LIVE_CONFIRMED=1` for
  live) together with the matching key and webhook secret. Test and live rows, customers,
  and totals stay separate: each gift records `livemode`, each person has one Stripe customer
  **per mode**, and statements count live money only. Switching back to test is safe.
- **Rotating the secret key.** Create the new key in Stripe, run
  `npx wrangler secret put STRIPE_SECRET_KEY`, deploy, confirm a small request works, then
  roll or delete the old key. Webhook secret rotation: Stripe signs with both secrets during
  the overlap, and the verifier accepts either, so update `STRIPE_WEBHOOK_SECRET` before the
  old one expires.
- **Refund runbook.** Refund in the Stripe dashboard. The `charge.refunded` event records the
  refunded amount; a full refund marks the gift **Refunded**, a partial refund leaves it
  succeeded with the amount netted out of totals and statements. Nothing is done in the app.
- **Dispute runbook.** A `charge.dispute.created` event marks the gift **Disputed** (out of
  totals and statements) and Stripe emails you. Respond in Stripe. A won dispute returns the
  gift to succeeded; a lost one stays disputed. If a statement for that year was already
  sent, issue a corrected one by queueing a new batch.
- **A bank (ACH) gift that never settles.** It stays **Pending**; the failure event flips it
  to **Failed**. Pending money is never counted.

The generated Supabase Worker runs webhook-inbox and pending-Checkout recovery on
`*/5 * * * *` (every five minutes) and, on the same tick, drains queued giving statements
(about ten emails per run). The operations page gives admins and finance users bounded,
audited recovery controls without rendering raw webhook payloads, Checkout request JSON,
customer email, secrets, or Checkout URLs. D1 does not support Giving, Registration, Stripe
operations, or this schedule.

See [`docs/features/giving.md`](./features/giving.md) and
[`docs/features/registration.md`](./features/registration.md) for how each module works
day to day.

---

## 8. Optional: reconciliation (Stripe FDW)

Once giving is enabled, you can turn on the **Reconcile** page (`/admin/giving/reconcile`),
which cross-checks your local ledger against Stripe and flags any drift — a gift Stripe has
but your ledger is missing, or the reverse. This is an optional audit convenience for the
Stripe checkout flow; without it, online gifts still work but are not cross-checked
through the Reconcile page. Use a restricted, read-only key for the matching mode (test
data for test mode, live data for live mode).

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

   Choose **Include demo content** to explore fictional examples, or **No demo content**
   to start with your own content. Both retain the same bundled design and local
   decorative assets. No demo content still applies all migrations and creates operational
   defaults, explicit module settings, church identity, and the first administrator.
   Noninteractive scripts can use `--demo-data` or `--no-demo-data` (the existing default).
   Rerunning no-demo setup does not remove records; use a separate fresh database to
   evaluate the other starting mode.

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
  configuration also runs the Stripe inbox, Checkout recovery, and giving-statement delivery every
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

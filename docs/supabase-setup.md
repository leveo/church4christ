# Supabase setup — for Giving and Registration

Most churches never need this page. The default setup uses Cloudflare **D1**, needs no
extra accounts, and runs every part of the site except two: **Giving** (online donations)
and **Registration** (paid event sign-ups). Those two modules need a full Postgres
database and Stripe, so they run on **Supabase** instead of D1.

Read this guide only if you want online giving or paid registration. If you do not, follow
[`deploy.md`](./deploy.md) with D1 and skip this entirely — you can always switch later.

> **New to all of this?** Read [`cloudflare-setup.md`](./cloudflare-setup.md) first — it
> explains, in plain language, what Cloudflare is and how the free hosting works. This page
> assumes you have already been through [`deploy.md`](./deploy.md) once, or are comfortable
> with a terminal.

> **Prefer to have an AI assistant do it?** Hand it this file. A good first thing to say:
> *"Read `docs/supabase-setup.md`, then walk me through switching this church site to the
> Supabase backend so we can turn on Giving. Ask me for anything you need — my Supabase
> connection string, my Stripe keys — one question at a time, and run the commands for me."*

---

## 1. Which database should I pick?

Both are free. The only reason to choose Supabase is to unlock the two Stripe-powered
modules; everything else works identically on either one.

| | **D1** (default) | **Supabase** (Postgres) |
|---|---|---|
| **Extra accounts to create** | None — just Cloudflare | A free Supabase account |
| **Setup effort** | Simplest (this is what `deploy.md` covers) | A few more steps (this page) |
| **Giving** (online card donations, recurring gifts) | Not available | **Available** |
| **Registration** (event sign-ups, free or paid) | Not available | **Available** |
| **Everything else** (bulletins, sermons, events, people, prayer wall, volunteer scheduling, articles, ministries, themes, email, two languages) | Yes | Yes |
| **Backups** | Nightly D1 → R2 copy you configure (`deploy.md` step 9) | Supabase's own automatic backups (nothing to configure) |
| **Monthly cost** | $0 (Cloudflare free tier) | $0 (Supabase free tier + Cloudflare free tier) |

Giving and Registration are **force-disabled on D1** — even if you switch them on in
**Settings → Modules**, they stay hidden until the site runs on Supabase. Switching the
backend is a one-line change (`DB_BACKEND`) plus the connection steps below.

---

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

```bash
npx wrangler hyperdrive create church4christ-db \
  --connection-string="postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
```

Use your own Session pooler string from step 2 (with the real password). The command prints
an **`id`** — copy it.

Now open `wrangler.jsonc` and make two changes:

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

Both of these live in `wrangler.jsonc`, which is **safe to commit** — the id is not a
secret, and your database password stays inside the Hyperdrive config in your Cloudflare
account, not in this file.

---

## 4. Create the tables

Point the migration script at your Supabase connection string. It applies every file in
`migrations-supabase/` once and tracks what it has run, so it is safe to run again.

```bash
SUPABASE_DB_URL="postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres" \
  npm run db:migrate:supabase
```

It prints `applying …` for each new file and finishes with `migrations up to date`. This
creates every table — the same content tables as D1, **plus** the giving and registration
tables. It does **not** load any content; a real deployment starts empty and you add your
church's content through the admin area.

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

Secrets never go in `wrangler.jsonc`. Set them with `wrangler secret put` — each command
prompts you to paste the value.

```bash
# Session signing key (same as the D1 setup). Generate a strong random value:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put SESSION_SECRET

# Stripe keys — do these after step 7, once you have the values from Stripe:
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

If you already deployed on D1, `SESSION_SECRET` is set and you can leave it. The two Stripe
secrets are the only new ones, and you can add them after you set up Stripe in step 7. Until
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set, the online giving form is inert and
paid registration cannot take money — everything else works. Redeploy after setting them:

```bash
npm run deploy
```

---

## 6. Create the first admin

Your new database is empty, so create your first administrator directly. Open the Supabase
dashboard → **SQL editor** → **New query**, and run this (adjust the name, email, and
language — the email is stored lowercase, so enter it lowercase):

```sql
INSERT INTO people (display_name, email, role, lang)
VALUES ('Your Name', 'you@yourchurch.org', 'admin', 'en');
```

This mirrors the D1 first-admin step in [`deploy.md`](./deploy.md#8-create-the-first-admin);
you are just running it in Supabase's SQL editor instead of through `wrangler d1 execute`.
Now open `https://<your-site>/en/signin`, enter that email, request a link, and click it —
you are in as an admin.

To let your treasurer manage giving without making them a full admin, open their profile in
`/admin/people` and turn on the **finance** flag. That grants the giving-admin pages
(record gifts, funds, reconcile) without the rest of the admin area.

---

## 7. Stripe setup (for Giving and Registration)

Card payments for both modules run through **Stripe**, so the church never handles a card
number. Set this up once.

1. **Create a Stripe account** at [stripe.com](https://stripe.com/) and stay in **test
   mode** (the toggle in the dashboard) while you try things out — test-mode keys and
   webhooks are completely separate from live ones, so you can experiment safely.

2. **Get your secret key.** In the Stripe dashboard → **Developers → API keys**, copy the
   **Secret key** (`sk_test_…` in test mode, `sk_live_…` in live mode). This is
   `STRIPE_SECRET_KEY`. For a hardened production setup you can instead create a
   **restricted key** with write access to Checkout Sessions and Billing Portal Sessions,
   and read access to Subscriptions.

3. **Add the webhook endpoint.** In **Developers → Webhooks → Add endpoint**, set the
   endpoint URL to:

   ```
   https://<your-site>/api/stripe/webhook
   ```

   Subscribe it to exactly these six events (this one endpoint serves both Giving and
   Registration — each event tells the app what happened):

   - `checkout.session.completed` — a card gift or a paid registration succeeded
   - `checkout.session.expired` — someone abandoned a registration checkout; frees the seat
   - `invoice.paid` — a recurring gift renewed
   - `charge.refunded` — a gift was refunded
   - `customer.subscription.updated` — a recurring gift's status changed
   - `customer.subscription.deleted` — a recurring gift was canceled

   After creating the endpoint, Stripe shows a **Signing secret** (`whsec_…`). That is
   `STRIPE_WEBHOOK_SECRET` — set it with `wrangler secret put` (step 5).

4. **Turn on the Customer Portal.** In **Settings → Billing → Customer portal**, activate
   it and save. This is what powers the **Manage** button on a member's *My giving* page,
   where they can update their card or cancel a recurring gift themselves.

5. **Choose your currency (optional).** Gifts default to US dollars. To use another
   currency, sign in as an admin and set the `giving.currency` site setting to its
   three-letter code (for example `cad` or `eur`).

6. **Go live when ready.** When you have tested with `sk_test_…` keys, switch Stripe to
   **live mode**, create a *live* secret key and a *live* webhook endpoint (same URL, same
   six events), and update both secrets to the live values, then `npm run deploy`.

See [`docs/features/giving.md`](./features/giving.md) and
[`docs/features/registration.md`](./features/registration.md) for how each module works
day to day.

---

## 8. Optional: reconciliation (Stripe FDW)

Once giving is live, you can turn on the **Reconcile** page (`/admin/giving/reconcile`),
which cross-checks your local ledger against Stripe and flags any drift — a gift Stripe has
but your ledger is missing, or the reverse. Online giving works fully without this; it is an
audit convenience, not a requirement.

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

To run the Supabase backend on your own computer, point it at a local Postgres instead of a
real Supabase project.

1. **Start a local Postgres** (Docker is easiest):

   ```bash
   docker run -d --name church-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
   ```

2. **Tell the dev server to use it.** In your `.dev.vars` file (copied from
   [`.dev.vars.example`](../.dev.vars.example)), set:

   ```bash
   DB_BACKEND=supabase
   WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://postgres:postgres@localhost:5432/postgres
   ```

   That second variable points the `HYPERDRIVE` binding at your local database, so you do
   **not** need a real Hyperdrive config for local dev.

3. **Migrate and seed the local database:**

   ```bash
   SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/postgres npm run db:migrate:supabase
   SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/postgres npm run db:seed:supabase
   ```

4. **Run it:** `npm run dev`, then open the address it prints (usually
   `http://localhost:4321`). Giving and Registration now appear, backed by your local
   Postgres.

5. **Testing Stripe locally (optional).** Put your test keys in `.dev.vars`
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
  the Cloudflare **Email** binding.
- **Scheduled jobs (crons)** — the nightly and weekly tasks in `wrangler.jsonc` (publishing
  scheduled bulletins, sending the digest) still run on Cloudflare's schedule.
- **Hyperdrive** — lives in your Cloudflare account and is what connects the Worker to
  Supabase.

**Backups.** The nightly **D1 → R2** backup (`deploy.md` step 9) is a D1-only feature — it
does not run on the Supabase backend, so leave `CF_ACCOUNT_ID`, `D1_DATABASE_ID`, and the
`D1_EXPORT_TOKEN` secret unset. Instead, rely on **Supabase's own automatic backups** (the
free tier takes daily backups; paid tiers add point-in-time recovery). Your data is still
yours, and still backed up — just by Supabase rather than by the Cloudflare cron.

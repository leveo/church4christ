# Deploying to Cloudflare

This is the full, from-scratch walkthrough to put Church4Christ online on Cloudflare's
free tier, with your own domain. It takes most people under an hour the first time. If you
would rather have an AI assistant do it, hand it this file (see the README's "Build it with
an AI assistant").

> **Cost.** A typical church site fits inside Cloudflare's **free tier** — Workers, D1, and
> R2 all have free allowances. A custom domain is the only thing you might pay for, and only
> if you do not already own one.

## Before you start

You need:

- **[Node.js](https://nodejs.org/) 22+** and the project installed locally (`npm install`).
  The Cloudflare CLI, `wrangler`, comes with it.
- A **free Cloudflare account** — sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
- Optionally, a **domain** you want the site to live on (for example `church.yourname.com`).

Authenticate the CLI once:

```bash
npx wrangler login
```

## 1. Create the database (D1) and media bucket (R2)

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
(`send_email`). To send real mail you must verify a sender address with Cloudflare and set
`allowed_sender_addresses` / `EMAIL_FROM` to it — see Cloudflare's Email documentation for
verifying a domain or address.

**For a first trial, before email is fully set up:** add `"EMAIL_DEV_LOG": "1"` to `vars`
in `wrangler.jsonc`. With it on, outgoing mail is **written to the Worker logs instead of
sent**. You can watch the logs with:

```bash
npx wrangler tail
```

and read the sign-in magic link straight from there — enough to complete the first admin
sign-in (step 8) and try the site end-to-end. Turn `EMAIL_DEV_LOG` off (remove it) once real
email is configured, so people actually receive their messages.

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

## 8. Create the first admin

The database is empty, so create your first administrator directly. Adjust the name, email,
and language:

```bash
npx wrangler d1 execute church4christ-db --remote \
  --command "INSERT INTO people (display_name, email, role, lang) VALUES ('Your Name', 'you@yourchurch.org', 'admin', 'en');"
```

Now open `https://church.yunfei-song.com/en/signin`, enter that email, and request a link.
The magic link is delivered by email (or, with `EMAIL_DEV_LOG=1`, appears in `wrangler tail`).
Click it and you are in as an admin. From there, set your church's name, address, service
times, and theme in **Settings**, and start adding content.

## 9. (Optional) Enable nightly backups

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
and entirely optional; the app is secure without it. Configure it in the Cloudflare Zero
Trust dashboard as a self-hosted application covering the `/admin*` path.

## Keeping it running

- **Redeploy** after any change with `npm run deploy`. The GitHub Actions workflow in
  `.github/workflows/ci.yml` can also deploy automatically on push to `main` if you add a
  `CLOUDFLARE_API_TOKEN` secret to the repository.
- **Update dependencies** periodically and run `npm audit` (see [`SECURITY.md`](../SECURITY.md)).
- **Never commit** `.dev.vars` or any secret — verify before every commit.

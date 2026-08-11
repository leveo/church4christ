# Cloudflare setup — a plain-language guide

New to all of this? Start here. This page explains **what you are setting up, which parts
can start within free allowances, and the two ways to do it** — without assuming you are a
developer. When you are ready for the exact commands, [`deploy.md`](./deploy.md) has the
precise step-by-step.

With Node.js 22.12.0 or newer installed, install the locked dependencies with `npm ci`.
The supported next step is:

```bash
npm run setup
```

Choose Local or Deploy, then choose Website, Website + Community, Full Church, or individual
features. Setup explains the required accounts, selects D1 or Supabase, prepares resources
and data, and bootstraps the first admin. Run `npm run doctor` for a readiness report.
Doctor checks what setup can inspect; it does not prove external email delivery, a live
sign-in, scheduled execution, or recovery from a backup.

You do **not** need to read this to try the site on your own computer first — that takes
five minutes and no accounts (see the [README quickstart](../README.md#try-it-in-5-minutes-on-your-own-computer)).
This page is for when you want to put your site **online for real**.

## What is Cloudflare, and why this project uses it

Cloudflare is a company that runs a huge, fast network of computers all over the world.
This project deploys to that network so pages can be served from locations near visitors.
Workers, D1, and R2 have free allowances that may cover a small site, but actual cost
depends on traffic, storage, email recipients, the selected database, and any optional
services.

This project uses four Cloudflare services. You do not need to understand how they work,
just what each one is for:

| Service | In plain terms | What it holds for your church |
|---|---|---|
| **Workers** | The engine that runs your website. | Every page, in both languages. |
| **D1** | A filing cabinet (a database). | Bulletins, sermons, events, people, the prayer wall. |
| **R2** | A photo/file storage room. | Images you upload in the admin area. |
| **Email** | A mail carrier. | Sign-in links and volunteer reminders. |

Email has different plan rules from the base Worker, database, and storage services. As of
this **August 2026 snapshot**:

- `EMAIL_DEV_LOG=1` is a local-development aid: it prints messages, including magic links,
  to the terminal and sends no email. Do not deploy it as an email configuration.
- Before any remote send, the sender domain must use Cloudflare DNS and be
  [onboarded for Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/).
- After that onboarding, a destination address verified in your Cloudflare account can be
  used for free controlled testing. Sending to arbitrary recipients requires the current
  **Workers Paid** plan.
- `allowed_sender_addresses` is a Worker-binding allowlist and `EMAIL_FROM` chooses the
  application's From address; neither setting onboards or verifies a domain. Configure
  both with an address on the onboarded sender domain. See
  [send-binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/).

Plans and limits can change. Check the official [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) before
launch and during operation.

> **One choice to know about: your database.** The **D1** filing cabinet above is the
> default for 14 modules. **Member Portal**, **Giving**, and **Registration** need Postgres,
> so setup selects **Supabase** when any of them is enabled. Local D1 needs no external
> account; deployed D1 needs Cloudflare. Local Supabase needs a local or hosted Supabase
> database; deployed Supabase needs both Cloudflare and Supabase. There is no automated
> D1↔Supabase content migration yet, so choose before entering production content.

## What it costs — honestly

- **The base Worker, D1, and R2 resources** can begin within Cloudflare's free allowances
  when usage stays within current limits. This is not a promise that every production
  deployment remains free.
- **Production email to arbitrary recipients** currently requires Workers Paid. A
  Supabase/Postgres backend and optional operational services can also add charges.
- **A domain name** (like `yourchurch.org`) is another possible cost — usually
  about **$10–15 a year** — unless you already own one. If your church already has a
  domain, you can use it.
- The project has no per-page software fee, but hosting and third-party plans remain your
  responsibility. These statements are an August 2026 snapshot and are subject to change;
  review the pricing links above for current terms.

## Guided setup or manual reference

### Path A — Let an AI assistant do it (easiest)

If you have [Claude Code](https://claude.com/claude-code) or a similar AI coding assistant,
you can hand it this whole project and ask it to walk you through going live. The project is
written to be read by an AI: the guides explain every step, and the assistant can run the
commands for you and explain what each one does. A good first thing to say:

> "Read `docs/cloudflare-setup.md` and `docs/deploy.md`, then walk me through putting this
> church site online on Cloudflare. Ask me for anything you need (like my church's name and
> domain) one question at a time, and run the commands for me."

This is the recommended path if commands and terminals are not your comfort zone. The
[README's "Build it with an AI assistant"](../README.md#build-it-with-an-ai-assistant)
section has more example requests.

### Path B — Manual troubleshooting reference

You will use a terminal and copy-paste a handful of commands. You do not need to write any
code. Normally `npm run setup` performs these operations. Here is the underlying shape for
troubleshooting; the exact manual commands live in [`deploy.md`](./deploy.md).

1. **Make a free Cloudflare account** at
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). Just an email and a
   password.
2. **Install Node.js 22.12.0 or newer, then install the project** on your computer
   (`npm ci`) — this also installs
   `wrangler`, Cloudflare's command-line helper — and **sign in** once with
   `npx wrangler login`. A browser window confirms it is you.
3. **Create your filing cabinet and storage room** — one command each creates your D1
   database and your R2 bucket.
4. **Paste one ID into a settings file** (`wrangler.jsonc`). The create command prints it;
   you copy it in. (This file is safe to share — it holds no passwords.)
5. **Create the tables** in your new database — one command.
6. **Set your secret sign-in key** (`SESSION_SECRET`) — one command generates and stores a
   strong random value. In the minimum D1 path, this is the only credential setup asks you
   to create. Supabase database URLs, Stripe credentials, and backup credentials are
   secrets too; none of them belongs in a file you share.
7. **For a local first try, use the terminal-only email log** (`EMAIL_DEV_LOG=1`, which
   guided Local setup writes to `.dev.vars`) to read your own sign-in link without sending
   email. A deployed test instead needs both an onboarded sender domain and a verified
   destination; production delivery also needs the plan described above.
8. **Publish** with `npm run deploy`. It prints a link you can open immediately.
9. **Point your own domain at it** (optional but nice). Setup has already bootstrapped the
   first administrator you selected.

Every one of these is spelled out, with the exact text to type, in
[`deploy.md`](./deploy.md).

**Stripe is test-only and Supabase-only.** D1 does not support Giving, Registration, or
Stripe operations. If your selected Supabase features accept payments, keep Stripe in test
mode and provide its credentials as one-shot inputs when you run setup:

```bash
CHURCH_SETUP_STRIPE_SECRET_KEY="sk_test_…" \
CHURCH_SETUP_STRIPE_WEBHOOK_SECRET="whsec_…" \
npm run setup
```

Setup stores the runtime secrets without printing them. It rejects live keys, and the site
rejects signed live webhook events with `400 live_mode_disabled` without storing them. The
Supabase configuration also installs the five-minute recovery schedule; D1 installs no
Stripe schedule.

## After you are live

- **Changing your site** is one command: `npm run deploy`. Edit content in the admin area;
  redeploy only when you change the code or design.
- **Keep control of your code and data.** Data lives in the Cloudflare D1 or Supabase
  account you select. Export it periodically; D1's optional nightly export is described in
  `deploy.md`, and Supabase needs the backup plan described in `supabase-setup.md`.
- **Operate it deliberately.** Read [`SECURITY.md`](../SECURITY.md), never share secret
  keys or commit `.dev.vars`, and keep up with dependency updates, backups, restore tests,
  and monitoring.

## If you get stuck

- The [full command walkthrough](./deploy.md) has a note on every step.
- Cloudflare's own docs are searchable at
  [developers.cloudflare.com](https://developers.cloudflare.com/).
- Or hand the error and this project to an AI assistant (Path A) and ask what to do next —
  that is often the fastest way through a snag.

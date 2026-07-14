# Cloudflare setup — a plain-language guide

New to all of this? Start here. This page explains **what you are setting up, why it is
free, and the two ways to do it** — without assuming you are a developer. When you are
ready for the exact commands, [`deploy.md`](./deploy.md) has the precise step-by-step.

The supported first step after `npm install` is:

```bash
npm run setup
```

Choose Local or Deploy, then choose Website, Website + Community, Full Church, or individual
features. Setup explains the required accounts, selects D1 or Supabase, prepares resources
and data, and bootstraps the first admin. Run `npm run doctor` for a readiness report.

You do **not** need to read this to try the site on your own computer first — that takes
five minutes and no accounts (see the [README quickstart](../README.md#try-it-in-5-minutes)).
This page is for when you want to put your site **online for real**.

## What is Cloudflare, and why this project uses it

Cloudflare is a company that runs a huge, fast network of computers all over the world.
They let anyone put a website on that network, and — for a site the size of a typical
church — **it costs nothing.** Your pages load quickly whether a visitor is across town or
across the ocean, because Cloudflare serves them from a location near that visitor.

This project uses four Cloudflare services. You do not need to understand how they work,
just what each one is for:

| Service | In plain terms | What it holds for your church |
|---|---|---|
| **Workers** | The engine that runs your website. | Every page, in both languages. |
| **D1** | A filing cabinet (a database). | Bulletins, sermons, events, people, the prayer wall. |
| **R2** | A photo/file storage room. | Images you upload in the admin area. |
| **Email** | A mail carrier. | Sign-in links and volunteer reminders. |

All four have a **free allowance** that a normal church website stays comfortably inside.
You are only ever billed if a site gets very large or very busy — and Cloudflare warns you
long before that.

> **One choice to know about: your database.** The **D1** filing cabinet above is the
> default for 14 modules. **Member Portal**, **Giving**, and **Registration** need Postgres,
> so setup selects **Supabase** when any of them is enabled. Local D1 needs no external
> account; deployed D1 needs Cloudflare. Local Supabase needs a local or hosted Supabase
> database; deployed Supabase needs both Cloudflare and Supabase. There is no automated
> D1↔Supabase content migration yet, so choose before entering production content.

## What it costs — honestly

- **The website itself: $0/month** on Cloudflare's free tier.
- **A domain name** (like `yourchurch.org`) is the one thing you might pay for — usually
  about **$10–15 a year** — and only if you do not already own one. If your church already
  has a domain, you can use it.
- No plugins to buy, no monthly subscription, no per-page fees.

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
2. **Install the project** on your computer (`npm install`) — this also installs
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
7. **Turn on "log emails to the screen"** for your first try (`EMAIL_DEV_LOG=1`), so you can
   grab your own sign-in link without email being fully configured yet.
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
- **Your data is yours.** It lives in your Cloudflare account, and the nightly backup
  (optional, see `deploy.md`) writes a copy you control.
- **Keep it safe.** Read [`SECURITY.md`](../SECURITY.md) — it is short and tells you the few
  things that matter (mainly: never share your secret key, and never commit the `.dev.vars`
  file).

## If you get stuck

- The [full command walkthrough](./deploy.md) has a note on every step.
- Cloudflare's own docs are searchable at
  [developers.cloudflare.com](https://developers.cloudflare.com/).
- Or hand the error and this project to an AI assistant (Path A) and ask what to do next —
  that is often the fastest way through a snag.

# Why these choices — who it's for, and the reasoning

This page explains **who this project is for**, the **problems it solves**, and **why it is
built the way it is** — why Cloudflare instead of a server on AWS/Azure/GCP, why the
Astro + Tailwind + TypeScript stack, and why you might (or might not) prefer a mature
service like Planning Center. It is written to be honest about the trade-offs, not to
claim this is right for everyone.

## Who this is for

- **Small and mid-size churches, Christian fellowships, and small nonprofits** — especially
  ones without a professional web team or a line item for software.
- **Bilingual and immigrant congregations.** English + Chinese (Simplified and Traditional)
  is a first-class feature here, not a paid add-on or an afterthought. Adding another
  language is a documented checklist, not a rebuild.
- **Ministries that want to own their content and their members' data** — in plain,
  exportable formats, on infrastructure they control.
- **People who are comfortable following a setup guide, or willing to let an AI assistant
  do it.** You do not need to be a developer, but you do need to run a handful of commands
  once (or hand the repo to Claude Code / Codex and let it do the running). See
  [`cloudflare-setup.md`](./cloudflare-setup.md).

If your church wants **zero technical involvement**, has budget for a subscription, and
needs a deep church-management suite (giving, check-ins, membership), a mature product
like **Planning Center** is likely the better fit — see the section below. This project is
for the churches that want **$0 cost, full control, and are fine with a little setup**.

## The pain points it solves

| Pain | The usual situation | What this project does |
|---|---|---|
| **Recurring cost** | WordPress hosting, Wix subscriptions, or per-seat/per-module SaaS fees that grow as you grow. | **$0/month** on Cloudflare's free tier. A domain (~$10–15/year) is the only likely cost. |
| **Vendor lock-in** | Your content and member data sit on a vendor's servers under their terms. | Your data lives in **your own account**, in open formats (a SQL database, Markdown files, plain image files) you can export anytime. |
| **The maintenance treadmill** | WordPress needs constant plugin and security updates; a self-run server needs OS patches and monitoring. | A small, self-contained, **heavily tested** codebase with no plugin ecosystem to keep patched. Update on your schedule. |
| **Bilingual is hard** | Multi-language is a bolt-on, a paid plugin, or two separate sites. | **Built in** from the ground up: per-field translation, a Simplified→Traditional toggle, and graceful fallback. |
| **Volunteer scheduling is a separate tool** | A second subscription (rosters, sign-ups, reminders). | **Integrated and free**: ministries, teams, plans, sign-ups, conflict checks, reminder emails, and an iCal feed. |
| **"The volunteer who built it left"** | The site becomes unmaintainable when its one technical person moves on. | The code and docs are written to be **read and changed by an AI assistant**, so the next person can maintain it by asking, in plain language. |

## Why Cloudflare — and not a server on AWS, Azure, or GCP

The short version: **there is no server to run.** A traditional cloud setup means renting
an always-on computer and becoming its part-time system administrator. For a church, that
is both a monthly bill and a long-term liability.

**A typical "server on AWS/Azure/GCP" setup** would be something like a virtual machine
(EC2 / App Service / Compute Engine) + a managed database + an object store + a load
balancer + TLS certificates. That means:

- **A monthly bill even when no one visits** — an always-on instance and managed database
  usually start around **$15–50+/month** and climb from there.
- **Ongoing operations** — OS and dependency patching, certificate renewal, backups,
  scaling, monitoring. This is real, recurring work, and it is exactly the work a church
  volunteer is least equipped to keep up with.
- **Many moving parts** — on AWS a comparable app wires together Lambda **or** EC2, RDS/
  Aurora, S3, SES, EventBridge, API Gateway, and IAM roles. More services, more accounts,
  more that can break.

**Cloudflare's model is different — "serverless at the edge":**

- **Nothing to run or patch.** You deploy code; Cloudflare runs it. No VM, no OS, no
  instance bill, no scaling to configure.
- **A free tier that genuinely covers a church.** Workers, the D1 database, R2 storage,
  email, and scheduled jobs all have free allowances (at the time of writing, on the order
  of 100,000 requests a day) that a normal congregation stays well inside. Check
  [Cloudflare's pricing](https://developers.cloudflare.com/workers/platform/pricing/) for
  current numbers.
- **Fast everywhere.** Pages are served from a location near the visitor, worldwide — which
  matters for diaspora congregations with members in other countries. A single-region
  server is slower for distant visitors unless you add (and pay for) a CDN.
- **One platform, one config, one command.** Workers + D1 + R2 + Email + Cron are the same
  platform, described in a single `wrangler.jsonc` file, shipped with `npm run deploy`. No
  CI/CD pipeline or infrastructure-as-code is required to get started.
- **No egress fees on R2.** Serving images and files does not rack up bandwidth charges the
  way some object stores do.

**The honest trade-offs.** The Workers runtime is an edge runtime, not a full server, and
D1 is SQLite-scale — great for a church website, not the right tool for an app with
millions of rows or heavy background computation. You are also choosing Cloudflare as your
platform, so the deployment glue is Cloudflare-specific. But your **data stays portable**
(standard SQL, Markdown, and image files), and the code is open source (GPL v3), so you are
never trapped: you can export everything and move if you ever need to.

## Why Astro + Tailwind + TypeScript

- **Astro** renders real HTML on the server and ships **almost no JavaScript** by default.
  For a site that is mostly content, that means pages are fast, accessible, work without
  JavaScript, and are simple to reason about — no heavy single-page-app framework to learn
  or maintain. Astro has first-class Cloudflare support, and its content collections give a
  clean, Markdown-based model for evergreen pages (about, beliefs, staff, articles). The
  few interactive pieces (the prayer-wall board, menus, the theme and language toggles) are
  small vanilla-JavaScript "islands" that **degrade gracefully** — everything still works
  with JavaScript turned off.
- **Tailwind (v4)** is driven entirely by the **design-token files**. Colors, fonts, radii,
  and shadows come from `design/*.json`, so re-theming the whole site — or adding a new
  theme — is a change to one config file, checked by an automatic contrast (accessibility)
  gate. There is no sprawling hand-written stylesheet to untangle, and a lint step forbids
  hardcoded colors so the design system can't be quietly bypassed.
- **TypeScript** catches mistakes before they ship and, just as importantly, makes the code
  **safe for an AI assistant or a non-expert to change** — the types guide correct edits and
  the 490+ automated tests catch regressions. That combination is what makes "maintain your
  site by chatting with Claude Code" actually trustworthy rather than a gamble.

The theme throughout: **fewer moving parts.** No client framework, no plugin ecosystem, no
server to babysit — a smaller thing that a small team (or one person and an AI) can actually
keep running for years.

## Why not Planning Center (or another mature church SaaS)?

**Planning Center is genuinely good, and this project is not trying to out-feature it.**
If you want a polished, zero-maintenance, deeply integrated church-management suite and you
have the budget, it is an excellent choice. The difference is in what you optimize for:

- **Cost and model.** Planning Center and similar tools are subscription SaaS, often priced
  per module and scaling with congregation size and features. This project is **free and
  yours** — no monthly bill, no per-seat math.
- **Ownership and control.** With SaaS, your members' data lives on the vendor's servers
  under their terms, and you customize only within what the product allows. Here you own the
  **database and the code**, and you can change anything.
- **The public website specifically.** Church-management SaaS is strongest at *internal*
  operations (giving, check-ins, membership). The **public-facing website** is often a
  separate problem — many churches pair a management tool with WordPress or Wix for the
  public site, which brings back exactly the cost and upkeep this project avoids. This
  project unifies the **public site + content CMS + volunteer scheduling** in one free,
  owned codebase.
- **Language and customization.** Bilingual and immigrant-church needs (English + Chinese,
  Simplified and Traditional) are often poorly served by template-based SaaS. Here they are
  a core, fully-customizable feature.

**Choose the mature SaaS when:** you want no technical involvement at all, you need deep
church-management features (online giving, check-in kiosks, a full membership database), and
owning the code is not a priority.

**Choose this project when:** you want $0 hosting cost, full control of your content and
data, a fast bilingual public site, and you are comfortable with a one-time setup — or you
have an AI assistant to do it for you.

---

New here? Start with the [README](../README.md), then
[`cloudflare-setup.md`](./cloudflare-setup.md) when you are ready to go online.

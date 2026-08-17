# Why these choices — who it's for, and the reasoning

This page explains **who this project is for**, the **problems it solves**, and **why it is
built the way it is** — why Cloudflare instead of a server on AWS/Azure/GCP, why the
Astro + Tailwind + TypeScript stack, and why you might (or might not) prefer a mature
church-management SaaS instead. It is written to be honest about the trade-offs, not to
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
needs a deep church-management suite (giving, check-ins, membership), a mature
commercial product is likely the better fit — see the section below. This project is for
churches that value **low starting infrastructure cost, control of their code and data,
and are fine with some setup and ongoing operation**.

## The pain points it solves

| Pain | The usual situation | What this project does |
|---|---|---|
| **Recurring cost** | WordPress hosting, Wix subscriptions, or per-seat/per-module SaaS fees that grow as you grow. | The base Worker, D1, and R2 resources can start within free allowances. Email to arbitrary recipients currently needs Workers Paid, and usage, a domain, Supabase, or operational services can add cost. |
| **Vendor lock-in** | Your content and member data sit on a vendor's servers under their terms. | Your data lives in **your own account**, in open formats (a SQL database, Markdown files, plain image files) you can export anytime. |
| **The maintenance treadmill** | WordPress needs constant plugin and security updates; a self-run server needs OS patches and monitoring. | A small, self-contained, **heavily tested** codebase with no plugin ecosystem to keep patched. Update on your schedule. |
| **Bilingual is hard** | Multi-language is a bolt-on, a paid plugin, or two separate sites. | **Built in** from the ground up: per-field translation, a Simplified→Traditional toggle, and graceful fallback. |
| **Volunteer scheduling is a separate tool** | A second subscription (rosters, sign-ups, reminders). | **Integrated in the codebase**: ministries, teams, plans, sign-ups, conflict checks, reminder emails, and an iCal feed. Email delivery follows the provider's plan rules. |
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

- **No VM or OS to administer.** You deploy code and Cloudflare runs the Worker. The
  project still needs dependency and security updates, backup and restore practice, and
  monitoring of application, scheduled-job, and email failures.
- **Useful free allowances for the base stack.** Workers, D1, and R2 can support evaluation
  and smaller sites within their current limits. Email is separate: every remote send first
  requires a sender domain on Cloudflare DNS that is onboarded for Email Sending. After
  onboarding, verified destinations support free controlled testing, while arbitrary
  recipients currently require Workers Paid. These are **August 2026 snapshots** and are
  subject to change; check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
  [Email Sending setup](https://developers.cloudflare.com/email-service/get-started/send-emails/),
  and [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/).
- **Fast everywhere.** Pages are served from a location near the visitor, worldwide — which
  matters for diaspora congregations with members in other countries. A single-region
  server is slower for distant visitors unless you add (and pay for) a CDN.
- **One deployment integration.** Workers, D1 or Hyperdrive-to-Postgres, R2, Email, and
  Cron are wired through Cloudflare-specific configuration and shipped with
  `npm run deploy`. No CI/CD pipeline or infrastructure-as-code is required to get started.
- **No egress fees on R2.** Serving images and files does not rack up bandwidth charges the
  way some object stores do.

**The honest trade-offs.** The Workers runtime is an edge runtime, not a full server, and
D1 is SQLite-scale — useful for a church website, but not the right tool for an app with
millions of rows or heavy background computation. The deployment glue is
Cloudflare-specific. The open-source code and exportable SQL, Markdown, and image data give
you meaningful control, but moving still requires manual exports, schema/data migration,
replacement service integrations, testing, and planned downtime. There is no zero-cost or
lossless switching guarantee.

## One database by default, a second one only if you need it

Many churches can use **Cloudflare D1** — locally it needs no external account, and it runs
all 18 D1-compatible modules. **Member Portal**, **Giving**, and **Registration** require
Postgres, so selecting any of those features chooses Supabase. Stripe integration is
currently limited to Preview/test-only online Giving and paid Registration flows; live
payments are unavailable. The offline/manual giving ledger and free Registration flows do
not depend on live Stripe processing.

The second backend is **Supabase** (managed Postgres). Guided setup chooses it from the
selected features and configures Hyperdrive. No automated D1↔Supabase content migration
exists; moving either direction requires a manual export and migration, and SQL portability
should not be read as a lossless-switch promise. See
[`supabase-setup.md`](./supabase-setup.md).

## Why Astro + Tailwind + TypeScript

- **Astro** renders real HTML on the server. Public pages do not ship a client framework;
  their interactive pieces use small vanilla-JavaScript scripts. The authenticated admin
  page builder is the deliberate exception: it loads one client-only React island. Astro
  has first-class Cloudflare support, and its content collections give a clean,
  Markdown-based model for evergreen pages (about, beliefs, staff, articles).
- **Tailwind (v4)** is driven entirely by the **design-token files**. Colors, fonts, radii,
  and shadows come from `design/*.json`, so re-theming the whole site — or adding a new
  theme — is a change to one config file, checked by an automatic contrast (accessibility)
  gate. There is no sprawling hand-written stylesheet to untangle, and a lint step forbids
  hardcoded colors so the design system can't be quietly bypassed.
- **TypeScript** catches many mistakes before they ship and makes changes easier to review —
  the types guide edits and the automated tests cover regressions. Tests and types reduce
  risk; they do not replace review, security updates, backups, or production monitoring.

The theme throughout: **fewer moving parts.** Public pages avoid a client framework, the
authenticated page builder uses React where its editing model benefits from it, and there
is no plugin ecosystem or VM to administer.

## Why not a mature church-management SaaS?

**The established church-management suites are genuinely good, and this project is not
trying to out-feature them.** If you want a polished, zero-maintenance, deeply integrated
church-management suite and you have the budget, they are an excellent choice. The
difference is in what you optimize for:

- **Cost and model.** Those tools are subscription SaaS, often priced per module and
  scaling with congregation size and features. This project's code is open source and has
  no per-seat software fee; Cloudflare, Supabase, email, domains, and operations can still
  create recurring costs.
- **Ownership and control.** With SaaS, your members' data lives on the vendor's servers
  under their terms, and you customize only within what the product allows. Here you own the
  **database and the code**, and you can change anything.
- **The public website specifically.** Church-management SaaS is strongest at *internal*
  operations (giving, check-ins, membership). The **public-facing website** is often a
  separate problem — many churches pair a management tool with WordPress or Wix for the
  public site, which brings back exactly the cost and upkeep this project avoids. This
  project unifies the **public site + content CMS + volunteer scheduling** in one
  self-controlled codebase.
- **Language and customization.** Bilingual and immigrant-church needs (English + Chinese,
  Simplified and Traditional) are often poorly served by template-based SaaS. Here they are
  a core, fully-customizable feature.

**Choose the mature SaaS when:** you want no technical involvement at all, you need deep
church-management features (online giving, check-in kiosks, a full membership database), and
owning the code is not a priority.

**Choose this project when:** you want control of your content and data, a low-cost path for
smaller workloads, a fast bilingual public site, and you are prepared for setup plus
ongoing dependency, security, backup, and monitoring work.

---

New here? Start with the [README](../README.md), then
[`cloudflare-setup.md`](./cloudflare-setup.md) when you are ready to go online.

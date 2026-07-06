# Security

This project handles real congregation data — names, emails, phone numbers, prayer
requests. Security is taken seriously. This document explains how to report a problem, what
the security model is, and the controls you must get right when you deploy.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.** Public issues are visible
to everyone, including anyone who might exploit the flaw before it is fixed.

Instead, report it privately through **GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**:
on the repository, go to the **Security** tab → **Report a vulnerability**. This opens a
private Security Advisory visible only to the maintainers. We will acknowledge it, work on a
fix, and coordinate disclosure with you.

## Security model

Church4Christ is built to be safe by default. The main controls:

- **Passwordless sign-in (magic links).** There are no passwords to leak or reuse. A sign-in
  link is single-use and short-lived, and **only a SHA-256 hash of the token is ever stored**
  — the raw link is never persisted. Consuming a token is an atomic database update, so a
  link cannot be replayed or used twice.
- **Session revocation by epoch.** Sessions are signed JWTs carrying a session-epoch claim.
  The middleware **reloads the person on every request** and compares the epoch, so a "sign
  out everywhere" (or an account deactivation) takes effect on the very next page load,
  across all devices.
- **CSRF protection.** State-changing requests (anything other than `GET`/`HEAD`/`OPTIONS`)
  are rejected unless the `Origin` header (or `Sec-Fetch-Site`) proves the request is
  same-origin. The session cookie is `HttpOnly` and `SameSite=Lax` as a backstop.
- **Security headers on every response** — `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and a strict `Referrer-Policy`. Pages rendered for a signed-in
  user are marked `Cache-Control: no-store`.
- **Role gates at two levels.** The middleware classifies every route and **fails closed** —
  an unknown `/admin/*` path is denied, not allowed — and each admin page independently
  enforces the finer editor/admin/leader rules. Access is checked before route existence, so
  a protected route never leaks its presence.
- **Media allowlist + path-traversal guard.** Uploaded images are stored in R2 under
  `uploads/` and served only through the `/media` route, which is structurally incapable of
  reaching any other prefix — so backups and anything else are never publicly downloadable,
  even via an encoded `../` key.
- **Upload limits.** Uploads are restricted to a small **image allowlist** (`jpeg`, `png`,
  `webp`, `gif`) with a **10 MB** cap. **SVG is deliberately rejected** (it is a scriptable
  format), and stored SVGs are never served inline — defense in depth.
- **HTML-escaping discipline.** Interpolated values in UI strings (`t(locale, key, vars)`)
  are HTML-escaped, so user- or admin-supplied text cannot inject markup.
- **Formula-injection-safe CSV.** Exported CSV cells that begin with `=`, `+`, `-`, `@`, or a
  control character are prefixed with a quote, so a crafted field (like a display name) cannot
  become a live formula when opened in Excel or Google Sheets.

## Deployment security checklist

Getting the code right is only half of it; a secure deployment also depends on you:

- [ ] **Use a strong `SESSION_SECRET`** — 32+ random bytes, set via `wrangler secret put
      SESSION_SECRET`. **Never** put it in `wrangler.jsonc` or `vars`.
- [ ] **Never commit `.dev.vars` or any secret.** They are already git-ignored — verify with
      `git status` before every commit anyway.
- [ ] **Placeholder IDs in `wrangler.jsonc` are safe to commit** (database/account IDs and
      the domain are not secrets). **`D1_EXPORT_TOKEN` is NOT** — it is a secret, set with
      `wrangler secret put`.
- [ ] **Rotate secrets when a staff member with access leaves.** Bumping a person's session
      epoch signs them out everywhere; rotating `SESSION_SECRET` signs out everyone.
- [ ] **(Optional) Put Cloudflare Access in front of `/admin`** for defense in depth on top
      of the app's own auth.
- [ ] **Keep dependencies updated** and run `npm audit` periodically.
- [ ] **Review the email log and admin activity** periodically for anything unexpected.
- [ ] **Keep the R2 bucket private** — media is exposed only through the `/media` allowlist,
      never by making the bucket public.
- [ ] **Backups contain member data.** Scope the D1 export API token to the **minimum**
      (export of that one database only), and treat the backup bucket as sensitive.

## Never commit

To be explicit, these must **never** be committed to the repository:

- **Secrets** of any kind — `SESSION_SECRET`, `D1_EXPORT_TOKEN`, API tokens.
- **`.dev.vars`** (or any local env file with real values).
- **Real member data** — a seed or fixture must use fictional people only.
- **Real emails or phone numbers** in the seed — the demo seed uses `@example.com` addresses
  and fictional numbers, and it must stay that way.

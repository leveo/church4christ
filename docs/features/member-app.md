# Member app (PWA)

A phone-first app for ordinary church members, opened from a phone browser and
installable on the home screen. It is part of the website: the same Worker, the same
database, the same sign-in and the same languages. There is no separate backend, app
store listing or build step.

## Where it lives

| Address | What it is |
| --- | --- |
| `/app` | Shareable entry (for a bulletin or a QR code). Opens the app in the language this device last chose, else the site's default language (**Settings → Languages**, English unless changed). |
| `/<locale>/app` | **Main**: church name and tagline, service times, address with map link, phone, email, current news (Events module), latest sermon (Sermons module), Plan a visit. |
| `/<locale>/app/events` | **Events**: the same in-window events as `/events`, plus events open for sign-up when Registration is on (each links to its registration page). |
| `/<locale>/app/groups` | **Groups**: My groups (signed in), the public group directory, and a page per group. |
| `/<locale>/app/give` | **Giving**: active funds and a **Give now** button that opens the website's secure `/give` checkout, with the fund chosen. My giving for signed-in members. |
| `/<locale>/app/offline` | Shown when the phone is offline and the page was never opened before. |
| `/<locale>/app/manifest.webmanifest`, `/<locale>/app/sw.js` | Web app manifest and service worker, one per language. |

The bottom bar shows **Main, Events, Groups** and, when Giving is on, **Giving**. The
hamburger menu at the top right holds sign in / my account / sign out, the language list
(the installation's enabled languages) and links to Plan a visit and the full website.

## Choosing the tabs

**Settings → Member app** (super admins):

- **Turn on the member app.** Off makes every `/app` page, the manifest and the service
  worker answer 404.
- **Tabs in the app.** Main, Events, Groups and Giving, all on by default. At least one
  must stay chosen. A tab also hides while the website module it reads from is off
  (Events, Groups, Giving), and comes back when the module is turned on again. Giving is
  Supabase-only, so on D1 the bar has three tabs. If Main is off, `/app` opens the first
  visible tab.

The choices are stored in the existing `settings` table as `app.enabled` and
`app.tab.<home|events|groups|giving>` (`'0'` = off, anything else or no row = on), per
campus like the other site settings. No migration.

## Privacy and access

App pages follow the website's rules: the route policy treats `/app` as public, and each
page filters member-only data the way the matching website page does. A private group is
a 404 for anyone who is not a member or a site admin, exactly like a missing group, and
the roster is shown only to members and site admins (names only). Joining a group creates
the same join request as the website. App pages are `noindex`; the website stays the copy
search engines see.

## Offline behavior

The service worker's scope is `/<locale>/app/` only; it never controls website pages.

- App pages are fetched from the network first. A page is kept for offline use only when
  the response is cacheable: pages rendered for a signed-in person carry `no-store` and are
  never written to the phone's cache.
- Hashed build assets (`/_astro/`) and the app icons are cached on first use.
- The offline page and icons are cached when the app is installed. A new release (package
  version) or a bump of `SW_REVISION` in `src/lib/memberApp.ts` replaces old caches.

## Icons

Home-screen icons are in `public/app-icons/` (192 px, 512 px, 512 px maskable, 180 px
Apple touch icon), made from the Church4Christ logo. To use your church's mark, replace
those four PNG files with the same names and sizes; the maskable one needs its artwork in
the middle 80%. The top bar shows the logo uploaded in **Settings → Appearance**.

## Try it on a phone: a demo installation

To check the app on a real phone without touching a church's live site, make a separate
installation with demo content on its own subdomain (here `app.church4christ.org`). It
gets its own Worker, D1 database and R2 bucket, all named after `--site-slug`, so it never
shares data with the main installation. Use a **separate clone**: the installer writes
`wrangler.jsonc`, `church.config.json` and `.church/` in the checkout it runs in.

```sh
git clone https://github.com/leveo/church4christ.git church4christ-app-demo
cd church4christ-app-demo
npm ci
npx wrangler login     # the Cloudflare account that has church4christ.org
npx wrangler whoami

ADMIN_EMAIL="you@example.org"   # an inbox you can read; it becomes the demo's admin
SETUP=(--mode deploy --preset website-community --demo-data --backend d1
  --site-slug church4christ-app-demo --church-name "Church4Christ Demo"
  --locales en,zh --default-locale en
  --admin-email "$ADMIN_EMAIL" --admin-name "Demo Admin"
  --app-origin https://app.church4christ.org --email-from demo@church4christ.org --yes)
node scripts/setup/index.mjs "${SETUP[@]}" --dry-run   # read the plan first
node scripts/setup/index.mjs "${SETUP[@]}"             # creates D1 + R2, migrates, seeds, makes the admin
npm run deploy -- --domain app.church4christ.org        # deploys and attaches the custom domain
node scripts/setup/index.mjs --doctor

curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://app.church4christ.org/app   # 302 .../en/app
curl -s https://app.church4christ.org/en/app | grep -o 'data-app-tab="[a-z]*"'
curl -s https://app.church4christ.org/en/app/manifest.webmanifest | head -c 200
```

Then open `https://app.church4christ.org/app` on the phone and add it to the home screen.
Everything public (Main, Events, the group directory, offline, install) works signed out.

- **Signing in:** there is no shared demo password. Sign-in is the usual emailed link, so
  onboard `church4christ.org` for Cloudflare Email Sending and verify `ADMIN_EMAIL` as a
  destination address (see [deploy: set up email](../deploy.md#5-set-up-email)), then
  sign in at `/en/signin` with that address. The demo content's people use `example.com`
  addresses that cannot receive mail; do not add a sign-in bypass to a deployed Worker.
- **Giving:** the demo above runs on D1, so the app shows three tabs. The Giving tab needs
  the Supabase backend ([Supabase setup](../supabase-setup.md)) with Stripe test keys.
- **Removing it:** delete the `church4christ-app-demo` Worker, its D1 database and its R2
  bucket in the dashboard.

## Known limits

- Sign-in uses the same emailed link as the website. On iPhone, an app added to the home
  screen keeps its own cookies, separate from Safari: open the sign-in link with the app
  installed and the session lands in Safari, not in the app. Members who need to be signed
  in inside the installed app can sign in from Safari and use the site there, or use the
  app from the browser tab.
- Payment, registration forms, group management, files and My account open the website
  pages (outside the app's scope, so the phone shows them with a close button).

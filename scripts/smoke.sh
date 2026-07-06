#!/usr/bin/env bash
# End-to-end smoke against the built worker running in workerd via `astro
# preview`. Boots the production build, then asserts routing, i18n, the health
# probe, the unknown-segment 404, and the baseline security headers over HTTP.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
npx astro preview --port 4322 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

BASE=http://localhost:4322
fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }
status() { curl -s -o /dev/null -w '%{http_code}' "$1"; }

# Wait for the server to accept connections (healthz needs no DB/session), and
# fail with a clear message if it never comes up instead of tripping errexit
# on the first assertion curl below.
for _ in $(seq 1 30); do
  curl -sf -o /dev/null "$BASE/healthz" && break
  sleep 1
done
curl -sf "$BASE/healthz" >/dev/null || fail "server never became reachable at $BASE"

# `/` → 302 to a localized home, with the nosniff header on the redirect itself.
root_status=$(status "$BASE/")
[ "$root_status" = "302" ] || fail "/ expected 302, got $root_status"
root_headers=$(curl -s -D - -o /dev/null "$BASE/")
echo "$root_headers" | grep -iqE '^location: /(en|zh)/' || fail "/ redirect location not /en/ or /zh/"
echo "$root_headers" | grep -iq '^x-content-type-options: nosniff' || fail "/ redirect missing nosniff header"

# `/en/` → 200 rendering the English brand name. Capture the body into a variable
# before grepping: the home page streams a chunked response, so piping curl
# straight into `grep -q` lets grep close the pipe on its first match and trip
# curl's SIGPIPE under `pipefail`. Buffering the whole body first (as the /zh/
# check below already does) avoids that false failure.
en_status=$(status "$BASE/en/")
[ "$en_status" = "200" ] || fail "/en/ expected 200, got $en_status"
en_body=$(curl -sf "$BASE/en/")
echo "$en_body" | grep -q 'Church4Christ' || fail "/en/ missing Church4Christ"

# `/zh/` → 200 with the Chinese brand name and the zh-Hans lang attribute.
zh_status=$(status "$BASE/zh/")
[ "$zh_status" = "200" ] || fail "/zh/ expected 200, got $zh_status"
zh_body=$(curl -sf "$BASE/zh/")
echo "$zh_body" | grep -q '四方基督教会' || fail "/zh/ missing 四方基督教会"
echo "$zh_body" | grep -q 'lang="zh-Hans"' || fail "/zh/ missing lang=\"zh-Hans\""

# `/healthz` → liveness JSON. Buffer the body before grepping (see the /en/ note
# above): piping curl straight into `grep -q` lets grep close the pipe on its
# match and trip curl's SIGPIPE under `pipefail`, a false failure that surfaces
# intermittently on faster CI runners.
healthz_body=$(curl -sf "$BASE/healthz")
echo "$healthz_body" | grep -q '{"ok":true}' || fail "/healthz not {\"ok\":true}"

# Unknown leading segment → real 404 (guard in [locale]/index.astro). The route
# policy's unknown-path fallback is `public` outside the protected namespaces
# (/admin, /my, /profile, /settings, /serve), so an anonymous typo URL reaches
# the natural 404 instead of bouncing to signin.
unknown_status=$(status "$BASE/totally-unknown")
[ "$unknown_status" = "404" ] || fail "/totally-unknown expected 404, got $unknown_status"

# A protected namespace still fails closed for anon: /en/my → 303 to signin,
# and the gate's redirect itself carries the baseline security headers.
my_headers=$(curl -s -D - -o /dev/null "$BASE/en/my")
echo "$my_headers" | grep -iq '^HTTP/1.1 303' || fail "/en/my expected 303 for anon"
echo "$my_headers" | grep -iqE '^location: /en/signin\?next=' || fail "/en/my redirect not to /en/signin"
echo "$my_headers" | grep -iq '^x-content-type-options: nosniff' || fail "/en/my redirect missing nosniff header"

# Admin console + admin-only people list both fail closed for anon (303 → signin).
admin_headers=$(curl -s -D - -o /dev/null "$BASE/admin")
echo "$admin_headers" | grep -iq '^HTTP/1.1 303' || fail "/admin expected 303 for anon"
echo "$admin_headers" | grep -iqE '^location: /en/signin\?next=' || fail "/admin redirect not to /en/signin"
people_headers=$(curl -s -D - -o /dev/null "$BASE/admin/people")
echo "$people_headers" | grep -iq '^HTTP/1.1 303' || fail "/admin/people expected 303 for anon"
echo "$people_headers" | grep -iqE '^location: /en/signin\?next=' || fail "/admin/people redirect not to /en/signin"

# Sign-in page renders its form, honeypot field included (anti-bot).
signin_status=$(status "$BASE/en/signin")
[ "$signin_status" = "200" ] || fail "/en/signin expected 200, got $signin_status"
signin_body=$(curl -sf "$BASE/en/signin")
echo "$signin_body" | grep -q '<form method="post"' || fail "/en/signin missing form"
echo "$signin_body" | grep -q 'name="website"' || fail "/en/signin missing honeypot input"
echo "$signin_body" | grep -q 'name="email"' || fail "/en/signin missing email input"

# Anti-enumeration: two POSTs with different emails must yield byte-identical
# "check your email" HTML — the page must not reveal whether an account exists.
post_a=$(curl -s -X POST -H "Origin: $BASE" --data-urlencode "email=probe-a@example.com" "$BASE/en/signin")
post_b=$(curl -s -X POST -H "Origin: $BASE" --data-urlencode "email=probe-b@example.com" "$BASE/en/signin")
echo "$post_a" | grep -q 'Check your email' || fail "signin POST missing success state"
[ "$post_a" = "$post_b" ] || fail "signin POST not anti-enumeration-safe (bodies differ by email)"

# POST /signout without a session: no work to do, just bounce home (303). Send a
# same-origin Origin header like a real browser form post would, so it clears
# both Astro's built-in and our middleware CSRF checks.
signout_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: $BASE" "$BASE/signout")
{ [ "$signout_status" = "303" ] || [ "$signout_status" = "405" ]; } || fail "POST /signout expected 303/405, got $signout_status"
signout_get=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/signout")
[ "$signout_get" = "405" ] || fail "GET /signout expected 405, got $signout_get"

# Slice 4 content pages: evergreen pages + collection indexes render 200 in both
# locales, driven by the content collections (glob loaders) and the give-page
# settings link. /en/visit carries the brand name; /zh/visit its localized title.
# Buffer each body before grepping (see the /en/ note above): a content page
# streams a chunked response and the brand name sits in the <title> near the top,
# so `curl … | grep -q` closes the pipe on its early match and trips curl's
# SIGPIPE under `pipefail` — a false "missing" failure seen on faster CI runners.
visit_en_status=$(status "$BASE/en/visit")
[ "$visit_en_status" = "200" ] || fail "/en/visit expected 200, got $visit_en_status"
visit_en_body=$(curl -sf "$BASE/en/visit")
echo "$visit_en_body" | grep -q 'Church4Christ' || fail "/en/visit missing Church4Christ"
visit_zh_status=$(status "$BASE/zh/visit")
[ "$visit_zh_status" = "200" ] || fail "/zh/visit expected 200, got $visit_zh_status"
visit_zh_body=$(curl -sf "$BASE/zh/visit")
echo "$visit_zh_body" | grep -q '计划到访' || fail "/zh/visit missing localized visit title"

for path in /en/about/staff /en/articles /en/fellowships /en/give; do
  s=$(status "$BASE$path")
  [ "$s" = "200" ] || fail "$path expected 200, got $s"
done

# Slice 4 Task 2: the home page renders the hero heading + its section landmarks
# (events strip, anchored prayer section with its honeypot), and the locale-free
# prayer-request API is POST-only (a bare GET must not render anything).
home_en=$(curl -sf "$BASE/en/")
echo "$home_en" | grep -q 'Find your place in God' || fail "/en/ missing hero title"
echo "$home_en" | grep -q 'Upcoming Events' || fail "/en/ missing events section landmark"
echo "$home_en" | grep -q 'id="prayer"' || fail "/en/ missing prayer section landmark"
echo "$home_en" | grep -q 'name="website"' || fail "/en/ missing prayer honeypot field"

prayer_get=$(status "$BASE/api/prayer-request")
{ [ "$prayer_get" = "405" ] || [ "$prayer_get" = "404" ]; } || fail "GET /api/prayer-request expected 405/404, got $prayer_get"

# Slice 4 Task 3: sermons / bulletin / prayer / events public pages render 200
# against the seeded DB; /en/bulletin carries a seeded bulletin marker (the
# rendered "Order of Worship" heading); an out-of-range sermon year 404s.
sermons_status=$(status "$BASE/en/sermons")
[ "$sermons_status" = "200" ] || fail "/en/sermons expected 200, got $sermons_status"

bulletin_status=$(status "$BASE/en/bulletin")
[ "$bulletin_status" = "200" ] || fail "/en/bulletin expected 200, got $bulletin_status"
bulletin_en=$(curl -sf "$BASE/en/bulletin")
echo "$bulletin_en" | grep -q 'Order of Worship' || fail "/en/bulletin missing seeded bulletin marker"

prayer_status=$(status "$BASE/zh/prayer")
[ "$prayer_status" = "200" ] || fail "/zh/prayer expected 200, got $prayer_status"

events_status=$(status "$BASE/en/events")
[ "$events_status" = "200" ] || fail "/en/events expected 200, got $events_status"

sermons_bad_year=$(status "$BASE/en/sermons/1999")
[ "$sermons_bad_year" = "404" ] || fail "/en/sermons/1999 expected 404, got $sermons_bad_year"

# Slice 4 Task 4: ministries directory + serve landing. The directory index lists
# a seeded ministry; the detail page renders in both locales (zh carries the
# localized name 敬拜); the serve landing shows its how-it-works heading (which is
# DB-independent, so it holds on an empty DB too).
ministries_status=$(status "$BASE/en/ministries")
[ "$ministries_status" = "200" ] || fail "/en/ministries expected 200, got $ministries_status"
ministries_en=$(curl -sf "$BASE/en/ministries")
echo "$ministries_en" | grep -q 'Worship' || fail "/en/ministries missing seeded ministry name"

min_detail_en=$(status "$BASE/en/ministries/worship")
[ "$min_detail_en" = "200" ] || fail "/en/ministries/worship expected 200, got $min_detail_en"

min_detail_zh_status=$(status "$BASE/zh/ministries/worship")
[ "$min_detail_zh_status" = "200" ] || fail "/zh/ministries/worship expected 200, got $min_detail_zh_status"
min_detail_zh=$(curl -sf "$BASE/zh/ministries/worship")
echo "$min_detail_zh" | grep -q '敬拜' || fail "/zh/ministries/worship missing localized name 敬拜"

serve_status=$(status "$BASE/en/serve")
[ "$serve_status" = "200" ] || fail "/en/serve expected 200, got $serve_status"
serve_en=$(curl -sf "$BASE/en/serve")
echo "$serve_en" | grep -q 'Three simple steps' || fail "/en/serve missing how-it-works heading"

# Slice 4 Task 5: the 简→繁 toggle button renders on zh pages only. The bodies
# were captured above (zh_body from /zh/, en_body from /en/).
echo "$zh_body" | grep -q 'data-zh-toggle' || fail "/zh/ missing data-zh-toggle button"
echo "$en_body" | grep -q 'data-zh-toggle' && fail "/en/ unexpectedly renders data-zh-toggle button"

# All three baseline security headers present on a rendered page.
en_headers=$(curl -s -D - -o /dev/null "$BASE/en/")
echo "$en_headers" | grep -iq '^x-content-type-options: nosniff' || fail "/en/ missing x-content-type-options"
echo "$en_headers" | grep -iq '^x-frame-options: DENY' || fail "/en/ missing x-frame-options"
echo "$en_headers" | grep -iq '^referrer-policy: strict-origin-when-cross-origin' || fail "/en/ missing referrer-policy"

echo "smoke OK"

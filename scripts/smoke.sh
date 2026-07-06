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

# `/en/` → 200 rendering the English brand name.
en_status=$(status "$BASE/en/")
[ "$en_status" = "200" ] || fail "/en/ expected 200, got $en_status"
curl -sf "$BASE/en/" | grep -q 'Church4Christ' || fail "/en/ missing Church4Christ"

# `/zh/` → 200 with the Chinese brand name and the zh-Hans lang attribute.
zh_status=$(status "$BASE/zh/")
[ "$zh_status" = "200" ] || fail "/zh/ expected 200, got $zh_status"
zh_body=$(curl -sf "$BASE/zh/")
echo "$zh_body" | grep -q '四方基督教会' || fail "/zh/ missing 四方基督教会"
echo "$zh_body" | grep -q 'lang="zh-Hans"' || fail "/zh/ missing lang=\"zh-Hans\""

# `/healthz` → liveness JSON.
curl -sf "$BASE/healthz" | grep -q '{"ok":true}' || fail "/healthz not {\"ok\":true}"

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
visit_en_status=$(status "$BASE/en/visit")
[ "$visit_en_status" = "200" ] || fail "/en/visit expected 200, got $visit_en_status"
curl -sf "$BASE/en/visit" | grep -q 'Church4Christ' || fail "/en/visit missing Church4Christ"
visit_zh_status=$(status "$BASE/zh/visit")
[ "$visit_zh_status" = "200" ] || fail "/zh/visit expected 200, got $visit_zh_status"
curl -sf "$BASE/zh/visit" | grep -q '计划到访' || fail "/zh/visit missing localized visit title"

for path in /en/about/staff /en/articles /en/fellowships /en/give; do
  s=$(status "$BASE$path")
  [ "$s" = "200" ] || fail "$path expected 200, got $s"
done

# All three baseline security headers present on a rendered page.
en_headers=$(curl -s -D - -o /dev/null "$BASE/en/")
echo "$en_headers" | grep -iq '^x-content-type-options: nosniff' || fail "/en/ missing x-content-type-options"
echo "$en_headers" | grep -iq '^x-frame-options: DENY' || fail "/en/ missing x-frame-options"
echo "$en_headers" | grep -iq '^referrer-policy: strict-origin-when-cross-origin' || fail "/en/ missing referrer-policy"

echo "smoke OK"

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

# Unknown segment for an anonymous visitor → the auth gate (slice 3) classifies
# unknown paths as `authed` and redirects to signin BEFORE route resolution, so a
# would-be 404 never renders. (Signed-in users fall through to the real 404.)
unknown_status=$(status "$BASE/totally-unknown")
[ "$unknown_status" = "303" ] || fail "/totally-unknown expected 303 (auth gate), got $unknown_status"
unknown_headers=$(curl -s -D - -o /dev/null "$BASE/totally-unknown")
echo "$unknown_headers" | grep -iqE '^location: /en/signin\?next=' || fail "/totally-unknown redirect not to /en/signin"

# All three baseline security headers present on a rendered page.
en_headers=$(curl -s -D - -o /dev/null "$BASE/en/")
echo "$en_headers" | grep -iq '^x-content-type-options: nosniff' || fail "/en/ missing x-content-type-options"
echo "$en_headers" | grep -iq '^x-frame-options: DENY' || fail "/en/ missing x-frame-options"
echo "$en_headers" | grep -iq '^referrer-policy: strict-origin-when-cross-origin' || fail "/en/ missing referrer-policy"

echo "smoke OK"

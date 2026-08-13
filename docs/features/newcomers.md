# Newcomer follow-up

The `newcomers` capability adds a consent-first public form at `/en/new-here` and
`/zh/new-here`, plus the staff queue at `/admin/newcomers`. It works with D1 or
PostgreSQL, depends on People, and does not require email delivery.

## Access and privacy

A narrow Newcomers grant can receive forms, use the queue, and perform follow-up actions
without gaining People or console-wide admin access. Only super admins can change statuses,
fields, and options. Disabling the capability returns 404 for its public and admin routes.

The public form requires explicit contact consent, uses a generic success response, and
never creates or changes a People record. Staff entry records the consent choice that staff
actually received. Answers and notes are rendered as text, not HTML.

## Rate limiting

Setup manages `NEWCOMER_RATE_LIMIT_SECRET`; manual deployments must add it with
`npx wrangler secret put NEWCOMER_RATE_LIMIT_SECRET`. The public route limits each normalized
contact to five attempts per ten minutes, a trusted `CF-Connecting-IP` to twenty, and the
shared unknown-IP bucket to five. `X-Forwarded-For` is ignored. Database rows contain only
keyed HMAC hashes and counters and expire after 48 hours. If the secret is missing, the form
returns a generic 503 and performs no database write.

## Staff workflow

Staff can filter the queue, open a card, assign it, change its core status, schedule a
follow-up, and add a note with conflict-safe updates. Duplicate suggestions are derived on
the server; linking is allowed only for an exact live contact match. Creating a visitor
requires both Newcomers and full People access, the People module, and an email address.
Phone-only records remain in the handoff workflow.

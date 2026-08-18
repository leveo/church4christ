# Launch readiness

Church4Christ keeps readiness definitions in `config/readiness.json`. Setup, `npm run doctor`,
and `/admin/onboarding` use the same stable check IDs and bilingual descriptions. The catalog
covers identity and locales, service times, staff grants, People migration decisions,
Newcomer ownership, attendance/check-in mapping, origin/domain/email, routes and jobs,
backups, and restore drills.

Every authenticated real administrator can read the admin checklist. It is an always-on,
non-grantable admin area: members and editors cannot open it, limited administrators need no
extra grant, and only a super administrator can acknowledge a manual check. Acknowledgements
record actor, time, and definition version. Restore-drill acknowledgements expire after 90
days; other acknowledgements remain current until their definition version changes.

Configuration presence is not operational proof. Routes, scheduled jobs, backups, and
restores remain manual or action-required until an operator verifies them. The page and
doctor never display secrets, provider payloads, contact records, backup contents, or
credential-bearing URLs.

For **Learning**, catalog/database readiness means only that the `people` dependency, module
setting, migrations `0017`–`0026`, and inspectable schedule/configuration are coherent. OAuth
consent and minimal scopes, Google Pub/Sub or Canvas Live Events delivery, real provider mapping,
manual/`:45` sync, `:15` cleanup/renewal, disconnect revocation, credential rotation, retention,
and matched restore are external/manual evidence. Setup, the admin checklist, and doctor do not
make provider calls or reveal provider configuration, so an operator must record those proofs in
the church's approved runbook before launch.

Doctor JSON uses schema version 2. Every item has exactly `checkId`, `status`, `severity`,
legacy `code`, `message`, and `remediation`. Normal mode fails only an error-level required
action; strict mode also fails warning-level required actions and manual checks.

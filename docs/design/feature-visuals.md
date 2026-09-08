# Feature documentation visuals

## Interface captures

Captured on 2026-09-08 (UTC) from the actual local application using fictional
`seed/dev-seed.sql` data, D1 migrations 0001–0037, Sanctuary light, and a 1280×800
viewport. The screenshot actor is seeded super administrator Alex Admin (Person 1,
session epoch 0). The local church date displayed in the report is September 7, 2026.

| Page | Output under docs/images/ | Framing |
| --- | --- | --- |
| /admin/activity-score | admin/activity-score-overview.png | Summary and source coverage |
| /admin/activity-score | admin/activity-score-calculation.png | Member activity; first calculation disclosure expanded |
| /admin/activity-score | admin/activity-score-model.png | Scoring model disclosure expanded |
| /admin/onboarding | admin/onboarding-readiness.png | Readiness summary and initial manual checks |

The Activity Score fixture uses the default 90-day model, with Group attendance and
Confirmed serving weighted 50 each. Registration and Learning are disabled in the model.
Registration is unavailable on this D1 backend. These are genuine calculated results;
the capture does not replace scores or fabricate participation. The onboarding image
shows unresolved local operational checks, not a production-ready installation.

Use a fresh, isolated local database. Set `WRANGLER_PERSIST_TO` to the same workspace
directory for both setup and the development server, and apply the migrations and demo
seed there. Set an ephemeral `SCREENSHOT_SESSION_SECRET` in the server and capture
process environments only. Keep `AUTH_DEV_BYPASS_EMAIL` unset. Never persist or print
the secret. Start `npm run dev` on a loopback address; then run:

```sh
node scripts/screenshots.mjs --base http://127.0.0.1:4335 --only admin/activity-score-overview.png,admin/activity-score-calculation.png,admin/activity-score-model.png,admin/onboarding-readiness.png
```

Replace the port with your actual local server port. On Windows, set `CHROME_PATH`
to the installed Chrome executable if automatic discovery does not find it.
The manifest supplies a fresh short-lived authenticated session for each image and checks
the route, page and identity markers, image encoding, dimensions, and minimum file size.
Native details panels are opened for calculation and model captures; no forms are submitted.
Stop the temporary server after capture.

## Generated workflows

The three PNG workflows below were created with the built-in image generation tool.
They are illustrations, not application screenshots. Their English labels, branch
directions, and key safeguards were visually checked. The corresponding feature pages
retain prose steps for accessibility, searching, and precise implementation details.

### Member identity

Output: [member-identity-source-flow.png](../images/diagrams/member-identity-source-flow.png)

Final generation prompt:

```text
Use case: infographic-diagram. Asset type: repository documentation workflow PNG. Create a polished highly legible English flowchart titled "Member identity". White background, navy text, teal verified path, amber review path, generous spacing, flat rounded cards and precise directional arrows. Landscape 1536x1024. Exact flow: one top source strip "Giving / Registration / Groups / Teams / Newcomer / Import" leads with ONE arrow to "Observe source record and changes", then "Normalize contact candidates" with subtitle "Store opaque digests", then split into two paths: left "One current verified owner" -> "OTP claim or signed account"; right "Ambiguous / shared / weak evidence" -> "Review / recovery case" -> "Continue only after approved resolution". Both paths join at "Revalidate owner and exact source version" -> "Attach source and continue business action" -> arrow labeled "Possible duplicate" -> "C1 sealed preview and approval controls". Footer "Names alone never trigger a merge". Keep all text exact, clear arrowheads and no bypass from unresolved review to attachment. No external provider names, no decorative people, no watermark.
```

### Activity Score

Output: [activity-score-workflow.png](../images/diagrams/activity-score-workflow.png)

Final generation prompt:

```text
Use case: infographic-diagram. Create an English documentation flowchart titled "Activity Score" subtitle "Explainable engagement for pastoral review". Landscape, white background, navy text, teal cards, amber exception cards, crisp large typography, ample whitespace, precise arrows. Main flow top to bottom: "Choose model" subtitle "30 / 60 / 90 / 180 days · Eligible membership · Weights total 100" -> four parallel source cards "Group attendance" / "Confirmed serving" / "Past registration engagement" / "Learning submissions (optional)" -> "Read bounded, person-linked evidence" subtitle "Current window + previous comparison window" -> "Calculate dimension scores" subtitle "Attendance ratio or count / target" -> "Weighted score · 0–100" -> "Admin report" subtitle "Trends · Score bands · Coverage · Calculation details" -> "Human pastoral review". Side exception connected from evidence: "Source unavailable" -> "Exclude dimension and renormalize weights" -> joins calculation; note "No sources or invalid evidence: show no scores". Footer "Excluded: giving, prayer, pastoral notes, learning grades and answers" and "No automatic messages, role changes or care tasks". Never imply registration is attendance. No provider brand names, no watermark.
```

### Launch readiness

Output: [onboarding-readiness-workflow.png](../images/diagrams/onboarding-readiness-workflow.png)

Generation prompt:

```text
Use case: infographic-diagram. Create a polished English documentation flowchart titled "Launch readiness" subtitle "One shared checklist from setup to ongoing operations". Landscape, white background, navy typography, teal cards and amber manual checks. Exact top source "Shared readiness catalog" subtitle "Stable check IDs · Versioned definitions" branches to three equal cards "Setup" / "npm run doctor" / "Admin launch checklist", which converge into "Evaluate readiness". Then split into two distinct paths: left "Configuration checks" -> "Fix required actions" -> "Run checks again"; right "Manual operational checks" subtitle "Email · Routes · Jobs · Backups · Restore drill" -> "Operator verifies real behavior" -> "Super admin acknowledges evidence" subtitle "Actor · Time · Definition version". Both converge into "Review current readiness before launch". Bottom note in amber "Configuration presence is not operational proof". Separate lifecycle note "Recheck after changes · Definition changes invalidate acknowledgements · Restore drills expire after 90 days". Use crisp arrowheads, uncluttered layout, no provider logos or names, no invented launch button, no watermark.
```

Final correction prompt, applied with the built-in tool to the generated image:

```text
Edit this diagram only: inside the top-left "Setup" card, replace its incorrect subtitle "npm run doctor" with the exact text "npm run setup". Preserve every other word, arrow, layout, color, and dimension unchanged.
```

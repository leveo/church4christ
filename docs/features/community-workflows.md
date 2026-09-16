# Campuses, optional fellowships, and workflows

Open **Campuses & Fellowships** in the admin sidebar. Choose a campus before making changes. The Groups administration grant controls this workspace and Workflows; assigning a fellowship coordinator label does not grant admin access.

A campus is a complete community workspace. It can own groups directly, use its existing campus membership list, and run welcome or care workflows. Fellowships are optional subdivisions with their own membership, meeting details, default coordinator, child groups, and workflow templates. There is no requirement to create a fellowship first.

- Campus → Groups
- Campus → Fellowship → Groups

Existing groups remain directly attached to their campus until an administrator explicitly assigns them. Moving a group preserves its roster, events, attendance, and existing permissions. Group members do not automatically become fellowship members. The public, editorial fellowship directory remains separately managed; private membership and follow-up records are never published there.

## Everyday use

1. Open a campus in **Campuses & Fellowships**. Manage its direct groups, or add an optional fellowship and assign groups to it. Campus access remains managed in the existing Campus settings console.
2. Open **Workflows** and select the campus or fellowship. Create a template with up to 20 steps. Each step has a title and a due date offset from the start (0–365 days).
3. Choose **Start manually**, or **When a member joins** with a default assignee. Automatic campus templates apply to memberships created after the template; use manual enrollment for existing members. Fellowship enrollment and automatic tasks are saved together. Each automatic template enrolls a person once, including after removal and restoration.
4. Start a manual workflow by choosing a person, an assignee, and a start time. The request is deduplicated on retry. Steps are copied into the plan, so existing plans keep their original content.
5. Assignees use **My follow-up tasks** to record progress and notes. They only see their own assignments. Community administrators can reassign tasks, change due times, toggle reminders, complete tasks, or cancel an entire plan. All date/time fields are explicitly UTC.
6. Pause a template to stop automatic enrollment and reminders for its plans. Archive a fellowship to pause its reminders without deleting groups or history.

## Cloudflare email reminders

The hourly Worker cron runs a bounded enrollment pass and then checks up to 20 due reminders. A task sends its first reminder when due and another every 24 hours while open. Completing or cancelling a task stops reminders. Each pass rechecks the active campus, Groups module, template, workflow, recipient membership, and person record. Automatic fellowship enrollment reminders also require the subject's fellowship membership to remain active.

Delivery uses the existing `EMAIL` binding and `EMAIL_FROM` through `src/lib/email.ts`. No separate email provider or API token is introduced. Messages contain a sign-in link and due time; member names, task details, and care notes stay behind authenticated access. Delivery attempts also appear in the existing email log.

1. Apply `0038_community_workflows.sql` using the repository's normal migration command for your selected database backend. Matching D1 and Supabase migrations are included.
2. Confirm the `send_email` binding, sender address, and sending domain are configured for your deployment. Cloudflare distinguishes sending to verified routing destinations from transactional sending to general recipients. See [Email Service](https://developers.cloudflare.com/email-service/) and [send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/).
3. Set `WORKFLOW_EMAIL_ENABLED=1` in the deployed Worker's environment when ready to activate reminders. It is off unless explicitly enabled. Keep the existing hourly `0 * * * *` trigger in `wrangler.jsonc`.
4. Confirm `APP_ORIGIN` points to the deployed site. Local development can use `EMAIL_DEV_LOG=1`; automated tests inject a fake sender and never deliver real emails.
5. Review the task's delivery status after an authorized test with an address you control. This implementation does not itself provision a domain or send a live test email.

Provider failures retry with backoff (1, 2, 4, and 8 hours after the first four failures). Five consecutive failed attempts require an administrator retry. Atomic claims prevent concurrent cron passes from sending the same pending reminder. A worker interrupted during delivery leaves an **uncertain** status after its ten-minute lease expires; it is not automatically resent. Administrators must acknowledge that the previous email may have been sent before retrying. A provider acceptance and a database receipt cannot be made one atomic transaction, so delivery is not claimed to be exactly once.

Email already accepted by the provider cannot be recalled by completing a task or pausing a template. Disabling `WORKFLOW_EMAIL_ENABLED` stops future reminder passes while task management remains available.

## Database and access boundaries

All six new tables carry campus partitions. Composite foreign keys prevent cross-campus group/fellowship and workflow parent relationships. Supabase tables enable RLS and revoke browser-role access; the existing server database connection is the access path. Existing campus roles and Groups permissions govern administrator operations, and assigned members can update only their own tasks through the member route. A fellowship role is descriptive and does not broaden permissions.

No example fellowships or real recipients are seeded. New interface text, templates, code comments, and documentation are English.

Identity merges with community membership, workflow subjects, or live ownership references require explicit review and reassignment; the merge preview blocks instead of silently moving follow-up or privileges. Historical task updater attribution is preserved.

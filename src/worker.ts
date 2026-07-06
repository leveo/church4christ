import { handle } from '@astrojs/cloudflare/handler';
import { sendReminders, sendWeeklyDigest } from './lib/digest';
import { type EmailEnv } from './lib/email';

// Custom Worker entry (mirrors the reference stack): @astrojs/cloudflare@14 has
// no workerEntryPoint option; its stock entry is literally `{ fetch: handle }`.
// The scheduled handler runs the crons declared in wrangler.jsonc — keep these
// cron strings in sync with that file.
const REMINDER_CRON = '0 13 * * *'; // daily serving reminders (remind7 / remind3)
const DIGEST_CRON = '0 14 * * 4'; // weekly serving digest (Thursday)
const BACKUP_CRON = '0 9 * * *'; // daily D1 backup (slice 7)

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled(controller, env, ctx) {
    // Each mail pass gates itself on the email_rules toggles; kick it off with
    // waitUntil so the scheduled invocation stays alive until the mail is sent.
    const vars = env as unknown as EmailEnv & { DB: D1Database };
    switch (controller.cron) {
      case REMINDER_CRON:
        ctx.waitUntil(sendReminders(vars, vars.DB));
        break;
      case DIGEST_CRON:
        ctx.waitUntil(sendWeeklyDigest(vars, vars.DB));
        break;
      case BACKUP_CRON:
        console.log('cron not implemented: backup');
        break;
      default:
        console.warn(`unhandled cron trigger: ${controller.cron}`);
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;

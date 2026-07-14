import { handle } from '@astrojs/cloudflare/handler';
import { sendReminders, sendWeeklyDigest } from './lib/digest';
import { sendAttendanceEmails } from './lib/groupAttendance';
import { type EmailEnv } from './lib/email';
import { runBackup, type MaybeBackupEnv } from './lib/backup';
import { clearModuleCache } from './lib/modules';
import { getBackend, openDb } from './lib/dbProvider';
import { runStripeRecovery } from './lib/stripeRecovery';

// Custom Worker entry (mirrors the reference stack): @astrojs/cloudflare@14 has
// no workerEntryPoint option; its stock entry is literally `{ fetch: handle }`.
// The scheduled handler runs the crons declared in wrangler.jsonc — keep these
// cron strings in sync with that file.
const REMINDER_CRON = '0 13 * * *'; // daily serving reminders (remind7 / remind3)
const DIGEST_CRON = '0 14 * * 4'; // weekly serving digest (Thursday)
const BACKUP_CRON = '0 9 * * *'; // daily D1 backup (slice 7)
const ATTENDANCE_CRON = '0 * * * *'; // hourly group-attendance tracker emails
const STRIPE_RECOVERY_CRON = '*/5 * * * *'; // Supabase durable inbox + Checkout recovery

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled(controller, env, ctx) {
    // Crons can run in a warm isolate whose module cache predates an admin
    // toggle; clear it so the serve-gate in the mail passes reads fresh state.
    clearModuleCache();
    // Each mail pass gates itself on the email_rules toggles; kick it off with
    // waitUntil so the scheduled invocation stays alive until the mail is sent.
    // Only the mail branches touch the database, so only they openDb — a
    // per-branch db + drainer, released by .finally(end) after the pass (a no-op
    // on D1). The backup/default branches never open a client to leak.
    const vars = env as unknown as EmailEnv;
    switch (controller.cron) {
      case REMINDER_CRON: {
        const { db, end } = openDb(env as never);
        ctx.waitUntil(sendReminders(vars, db).finally(end));
        break;
      }
      case DIGEST_CRON: {
        const { db, end } = openDb(env as never);
        ctx.waitUntil(sendWeeklyDigest(vars, db).finally(end));
        break;
      }
      case ATTENDANCE_CRON: {
        const { db, end } = openDb(env as never);
        ctx.waitUntil(sendAttendanceEmails(vars, db).finally(end));
        break;
      }
      case BACKUP_CRON:
        // The D1 SQL export is D1-specific: on the supabase backend, skip it —
        // Supabase runs its own managed backups (getBackend reads the var without
        // opening a client). Otherwise export D1 and write backups/YYYY-MM-DD.sql
        // to R2 (also log-and-skips when the export vars/secret are unset, e.g.
        // demo deploy). The key date comes from the cron's scheduledTime, not
        // wall clock, so jitter can't shift the date.
        if (getBackend(env as never) !== 'd1') {
          console.log('backup skipped: supabase backend has its own backups');
          break;
        }
        ctx.waitUntil(runBackup(env as unknown as MaybeBackupEnv, new Date(controller.scheduledTime)));
        break;
      case STRIPE_RECOVERY_CRON:
        if (getBackend(env as never) !== 'supabase') break;
        ctx.waitUntil(runStripeRecovery({ env: env as never }));
        break;
      default:
        console.warn(`unhandled cron trigger: ${controller.cron}`);
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;

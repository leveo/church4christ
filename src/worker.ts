import { handle } from '@astrojs/cloudflare/handler';
import { sendReminders, sendWeeklyDigest } from './lib/digest';
import { type EmailEnv } from './lib/email';
import { runBackup, type MaybeBackupEnv } from './lib/backup';
import { clearModuleCache } from './lib/modules';
import { openDb } from './lib/dbProvider';

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
    // Crons can run in a warm isolate whose module cache predates an admin
    // toggle; clear it so the serve-gate in the mail passes reads fresh state.
    clearModuleCache();
    // Each mail pass gates itself on the email_rules toggles; kick it off with
    // waitUntil so the scheduled invocation stays alive until the mail is sent.
    // openDb hands back a per-invocation db + drainer; .finally(end) releases the
    // supabase client after the pass (a no-op on D1).
    const vars = env as unknown as EmailEnv;
    const { db, backend, end } = openDb(env as never);
    switch (controller.cron) {
      case REMINDER_CRON:
        ctx.waitUntil(sendReminders(vars, db).finally(end));
        break;
      case DIGEST_CRON:
        ctx.waitUntil(sendWeeklyDigest(vars, db).finally(end));
        break;
      case BACKUP_CRON:
        // The D1 SQL export is D1-specific: on the supabase backend, skip it —
        // Supabase runs its own managed backups. Otherwise export D1 and write
        // backups/YYYY-MM-DD.sql to R2 (also log-and-skips when the export
        // vars/secret are unset, e.g. demo deploy). The key date comes from the
        // cron's scheduledTime, not wall clock, so jitter can't shift the date.
        if (backend !== 'd1') {
          console.log('backup skipped: supabase backend has its own backups');
          break;
        }
        ctx.waitUntil(runBackup(env as unknown as MaybeBackupEnv, new Date(controller.scheduledTime)));
        break;
      default:
        console.warn(`unhandled cron trigger: ${controller.cron}`);
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;

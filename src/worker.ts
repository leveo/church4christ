import { runCommunityWorkflowPass } from './lib/workflowReminders';
import { handle } from '@astrojs/cloudflare/handler';
import { sendReminders, sendWeeklyDigest } from './lib/digest';
import { sendPlanningReminders } from './lib/planningNotify';
import { sweepReminders, sweepUnsentConfirmations } from './lib/regNotify';
import { sweepOutbox } from './lib/regMessaging';
import { sendAttendanceEmails } from './lib/groupAttendance';
import { type EmailEnv } from './lib/email';
import { runBackup, type MaybeBackupEnv } from './lib/backup';
import { clearModuleCache } from './lib/modules';
import { getBackend, openDb } from './lib/dbProvider';
import { runStripeRecovery } from './lib/stripeRecovery';
import { runStatementDrain } from './lib/givingStatements';
import { runGoogleClassroomRegistrationRenewalPass } from './lib/learningGoogleRegistrationCron';
import { runCanvasDisconnectCleanupPass } from './lib/learningCanvasCleanupCron';
import { runScheduledLearningSyncPass } from './lib/learningSyncOrchestration';
import { runIdentityRecoveryNotificationSweep } from './lib/identityRecoveryOutbox';
import { expireIdentityBusinessContinuations } from './lib/identityBusinessContinuation';
import { enqueueDuePlanningCenterSyncJobs, runPlanningCenterSyncPass } from './lib/planningCenterSync';

// Custom Worker entry (mirrors the reference stack): @astrojs/cloudflare@14 has
// no workerEntryPoint option; its stock entry is literally `{ fetch: handle }`.
// The scheduled handler runs the crons declared in wrangler.jsonc — keep these
// cron strings in sync with that file.
const REMINDER_CRON = '0 13 * * *'; // daily serving reminders (remind7 / remind3)
const DIGEST_CRON = '0 14 * * 4'; // weekly serving digest (Thursday)
const BACKUP_CRON = '0 9 * * *'; // daily D1 export schedule (unused by Supabase)
const ATTENDANCE_CRON = '0 * * * *'; // hourly group-attendance tracker emails
const GOOGLE_CLASSROOM_REGISTRATION_CRON = '15,45 * * * *'; // isolated Classroom cleanup + renewal budget
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
        // Volunteer reminders and Service Planning rehearsal reminders share the
        // daily job (no extra cron), as does the registration confirmation retry sweep.
        // Each pass gates on its own module and rules, and one failing must not stop the others.
        ctx.waitUntil((async () => {
          try { await sendReminders(vars, db); }
          finally {
            // Registration event reminders (module-gated per campus), isolated from the passes around them.
            try { await sweepReminders(vars, db); }
            finally {
              try { await sendPlanningReminders(vars, db); }
              finally { await sweepUnsentConfirmations(vars, db); }
            }
          }
        })().finally(end));
        break;
      }
      case DIGEST_CRON: {
        const { db, end } = openDb(env as never);
        ctx.waitUntil(sendWeeklyDigest(vars, db).finally(end));
        break;
      }
      case ATTENDANCE_CRON: {
        const { db, end } = openDb(env as never);
        ctx.waitUntil((async () => {
          try { await Promise.all([sendAttendanceEmails(vars, db), runCommunityWorkflowPass(env as never, db)]); }
          finally {
            try { await enqueueDuePlanningCenterSyncJobs(db); await runPlanningCenterSyncPass(env as never, db); }
            finally {
              try { await runIdentityRecoveryNotificationSweep(env as never, db); }
              finally {
                try {
                  const scheduledAt = new Date(controller.scheduledTime).toISOString().slice(0, 19).replace('T', ' ');
                  await expireIdentityBusinessContinuations(db, { now: scheduledAt });
                } finally {
                  // Registration bulk email: up to 100 queued rows per run (no new cron).
                  await sweepOutbox(vars, db);
                }
              }
            }
          }
        })().finally(end));
        break;
      }
      case GOOGLE_CLASSROOM_REGISTRATION_CRON: {
        const { db, end } = openDb(env as never);
        ctx.waitUntil((async () => {
          // Reuse one cron trigger without combining two provider-heavy jobs in
          // one Free-plan invocation: :15 is cleanup/registration readiness;
          // :45 is one bounded authoritative course reconciliation.
          if (new Date(controller.scheduledTime).getUTCMinutes() === 45) {
            await runScheduledLearningSyncPass(env as never, db);
            return;
          }
          try { await runCanvasDisconnectCleanupPass(env as never, db); }
          catch { /* the durable Canvas task remains available to the next bounded pass */ }
          await runGoogleClassroomRegistrationRenewalPass(env as never, db);
        })().finally(end));
        break;
      }
      case BACKUP_CRON:
        // The application-level SQL export is D1-specific. Supabase operators
        // need manual off-site exports or backups included with their selected
        // Supabase plan (getBackend reads the var without opening a client).
        // Otherwise export D1 and write backups/YYYY-MM-DD.sql to R2 (also
        // log-and-skips when the export vars/secret are unset, e.g. demo deploy).
        // The key date comes from the cron's scheduledTime, not wall clock, so
        // jitter can't shift the date.
        if (getBackend(env as never) !== 'd1') {
          console.log(
            'backup skipped: Supabase needs manual off-site exports or backups from the selected Supabase plan',
          );
          break;
        }
        ctx.waitUntil(runBackup(env as unknown as MaybeBackupEnv, new Date(controller.scheduledTime)));
        break;
      case STRIPE_RECOVERY_CRON:
        if (getBackend(env as never) !== 'supabase') break;
        // The annual giving-statement outbox rides this existing tick (no extra
        // cron): a bounded batch drains after Stripe recovery, in its own
        // try/finally so a recovery failure never starves statement delivery.
        ctx.waitUntil((async () => {
          try {
            await runStripeRecovery({ env: env as never });
          } finally {
            try {
              await runStatementDrain(env as never);
            } catch (error) {
              console.error('giving statement drain failed', error instanceof Error ? error.name : 'unknown');
            }
          }
        })());
        break;
      default:
        console.warn(`unhandled cron trigger: ${controller.cron}`);
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;

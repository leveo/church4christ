import { handle } from '@astrojs/cloudflare/handler';

// Custom Worker entry (mirrors the reference stack): @astrojs/cloudflare@14 has
// no workerEntryPoint option; its stock entry is literally `{ fetch: handle }`.
// The scheduled handler runs the crons declared in wrangler.jsonc — keep these
// cron strings in sync with that file. Each case is a stub until later slices.
const REMINDER_CRON = '0 13 * * *'; // daily event reminders
const DIGEST_CRON = '0 14 * * 4'; // weekly digest (Thursday)
const BACKUP_CRON = '0 9 * * *'; // daily D1 backup

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled(controller, _env, _ctx) {
    switch (controller.cron) {
      case REMINDER_CRON:
        console.log('cron not implemented: reminders');
        break;
      case DIGEST_CRON:
        console.log('cron not implemented: digest');
        break;
      case BACKUP_CRON:
        console.log('cron not implemented: backup');
        break;
      default:
        console.warn(`unhandled cron trigger: ${controller.cron}`);
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;

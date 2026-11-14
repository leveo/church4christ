// Service Planning reminders ride the existing daily reminder cron: the worker
// calls the planning pass from the same branch as the volunteer reminders, and no
// new cron trigger is declared anywhere.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const worker = readFileSync('src/worker.ts', 'utf8');
const wrangler = readFileSync('wrangler.jsonc', 'utf8');

describe('planning reminder cron wiring', () => {
  it('runs the planning reminder pass in the daily reminder branch after the volunteer reminders', () => {
    const branch = worker.slice(worker.indexOf('case REMINDER_CRON'), worker.indexOf('case DIGEST_CRON'));
    expect(branch).toContain('sendReminders(vars, db)');
    expect(branch).toContain('sendPlanningReminders(vars, db)');
    expect(branch.indexOf('sendReminders(vars, db)')).toBeLessThan(branch.indexOf('sendPlanningReminders(vars, db)'));
    expect(branch).toMatch(/finally\(end\)/);
  });

  it('keeps the declared cron triggers unchanged', () => {
    const crons = [...worker.matchAll(/const [A-Z_]+_CRON = '([^']+)'/g)].map((m) => m[1]);
    expect(crons).toEqual(['0 13 * * *', '0 14 * * 4', '0 9 * * *', '0 * * * *', '15,45 * * * *', '*/5 * * * *']);
    // The Supabase-only */5 recovery trigger is added by the generated config; the baseline declares the other five.
    for (const cron of crons.slice(0, 5)) expect(wrangler).toContain(`"${cron}"`);
  });
});

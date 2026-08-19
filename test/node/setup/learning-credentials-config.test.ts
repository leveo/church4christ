import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Learning credential local configuration', () => {
  it('does not require secrets to build the open-source Wrangler configuration', () => {
    const config = readFileSync('wrangler.jsonc', 'utf8');
    const template = readFileSync('config/wrangler.template.jsonc', 'utf8');
    const example = readFileSync('.dev.vars.example', 'utf8');
    expect(config).not.toContain('"secrets"');
    expect(template).not.toContain('"secrets"');
    for (const name of [
      'LEARNING_CREDENTIAL_KEYS', 'GOOGLE_CLASSROOM_CLIENT_ID', 'GOOGLE_CLASSROOM_CLIENT_SECRET',
      'CANVAS_ALLOWED_ORIGINS', 'CANVAS_OAUTH_CLIENT_ID', 'CANVAS_OAUTH_CLIENT_SECRET',
    ]) {
      expect(config).not.toContain(`"${name}"`);
      expect(template).not.toContain(`"${name}"`);
      expect(example).toContain(`# ${name}=`);
      expect(example).not.toMatch(new RegExp(`^${name}=.+$`, 'm'));
      expect(example).toContain(`wrangler secret put ${name}`);
    }
    for (const name of [
      'GOOGLE_CLASSROOM_PUBSUB_TOPIC',
      'GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL',
      'GOOGLE_PUBSUB_SUBSCRIPTION_NAME',
    ]) {
      expect(config).toContain(`// "${name}"`);
      expect(template).toContain(`// "${name}"`);
      expect(example).toContain(`# ${name}=`);
      expect(example).not.toMatch(new RegExp(`^${name}=.+$`, 'm'));
    }
    expect(example).toContain('AES-256-GCM');
    expect(example).toContain('CANVAS_ALLOWED_ORIGINS is a bounded JSON array of exact HTTPS origins');
  });

  it('isolates bounded Learning provider maintenance in its own twice-hourly Worker invocation', () => {
    const worker = readFileSync('src/worker.ts', 'utf8');
    const attendanceCase = worker.slice(
      worker.indexOf('case ATTENDANCE_CRON:'),
      worker.indexOf('case GOOGLE_CLASSROOM_REGISTRATION_CRON:'),
    );
    const googleCase = worker.slice(
      worker.indexOf('case GOOGLE_CLASSROOM_REGISTRATION_CRON:'),
      worker.indexOf('case BACKUP_CRON:'),
    );
    expect(worker).toContain("const GOOGLE_CLASSROOM_REGISTRATION_CRON = '15,45 * * * *'");
    expect(attendanceCase).toContain('sendAttendanceEmails(vars, db).finally(end)');
    expect(attendanceCase).not.toContain('runGoogleClassroomRegistrationRenewalPass');
    expect(googleCase).toContain('await runCanvasDisconnectCleanupPass(env as never, db)');
    expect(googleCase).toContain('await runGoogleClassroomRegistrationRenewalPass(env as never, db)');
    expect(googleCase).toContain('})().finally(end)');
    expect(googleCase.indexOf('runCanvasDisconnectCleanupPass'))
      .toBeLessThan(googleCase.indexOf('runGoogleClassroomRegistrationRenewalPass'));
    expect(googleCase).not.toContain('sendAttendanceEmails');
    expect(worker).not.toMatch(/learningGoogle[^\n]*(?:retry|backoff|setTimeout)/iu);
  });
});

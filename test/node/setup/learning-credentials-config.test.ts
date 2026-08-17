import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Learning credential secret declaration', () => {
  it('declares only the secret name in Wrangler and a value-free local example', () => {
    const config = readFileSync('wrangler.jsonc', 'utf8');
    const template = readFileSync('config/wrangler.template.jsonc', 'utf8');
    const example = readFileSync('.dev.vars.example', 'utf8');
    expect(config).toContain('"secrets": { "required": [');
    for (const name of [
      'LEARNING_CREDENTIAL_KEYS', 'GOOGLE_CLASSROOM_CLIENT_ID', 'GOOGLE_CLASSROOM_CLIENT_SECRET',
    ]) {
      expect(config).toContain(`"${name}"`);
      expect(template).toContain(`"${name}"`);
      expect(config).not.toMatch(new RegExp(`${name}\\s*[:=]\\s*["'][A-Za-z0-9+/={]`));
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
    const requiredSecrets = config.slice(config.indexOf('"secrets"'), config.indexOf('"triggers"'));
    expect(requiredSecrets).not.toMatch(/GOOGLE_(?:CLASSROOM_PUBSUB_TOPIC|PUBSUB_)/u);
    expect(example).toContain('AES-256-GCM');
  });

  it('isolates the bounded Classroom renewal pass in its own hourly Worker invocation', () => {
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
    expect(googleCase).toContain('runGoogleClassroomRegistrationRenewalPass(env as never, db).finally(end)');
    expect(googleCase).not.toContain('sendAttendanceEmails');
    expect(worker).not.toMatch(/learningGoogle[^\n]*(?:retry|backoff|setTimeout)/iu);
  });
});

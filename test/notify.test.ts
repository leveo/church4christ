// Scheduling notifications (workers project, migrated D1). Each function is
// best-effort and, under EMAIL_DEV_LOG, writes a devlog row to email_log; the
// scheduling request also stamps notified_at and mints a respond token.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  sendApplicationReceived,
  sendApplicationResult,
  sendDeclineNotice,
  sendSchedulingRequest,
  sendServeInvite,
} from '../src/lib/notify';

const ENV = { EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' };

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people (id, display_name, email, lang) VALUES
      (1, 'Leader', 'leader@example.com', 'en'),
      (2, 'Volunteer', 'vol@example.com', 'en'),
      (3, 'Applicant', 'app@example.com', 'zh')`),
    env.DB.prepare(`INSERT INTO teams (id) VALUES (1)`),
    env.DB.prepare(`INSERT INTO team_i18n (team_id, locale, name) VALUES (1, 'en', 'Worship')`),
    env.DB.prepare(`INSERT INTO positions (id, team_id) VALUES (1, 1)`),
    env.DB.prepare(`INSERT INTO position_i18n (position_id, locale, name) VALUES (1, 'en', 'Vocalist')`),
    env.DB.prepare(`INSERT INTO team_members (team_id, person_id, is_leader) VALUES (1, 1, 1)`),
    env.DB.prepare(`INSERT INTO service_types (id) VALUES (1)`),
    env.DB.prepare(`INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES (1, 'en', 'Sunday')`),
    env.DB.prepare(`INSERT INTO plans (id, service_type_id, plan_date) VALUES (1, 1, '2030-09-06')`),
    env.DB.prepare(`INSERT INTO plan_positions (plan_id, position_id, needed) VALUES (1, 1, 1)`),
    env.DB.prepare(`INSERT INTO roster_assignments (id, plan_id, position_id, person_id, status) VALUES (1, 1, 1, 2, 'U')`),
    env.DB.prepare(`INSERT INTO team_applications (id, person_id, team_id, status) VALUES (1, 3, 1, 'P')`),
  ]);
});

const logCount = async (to: string, kind: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_log WHERE to_email = ? AND kind = ? AND status = 'devlog'`).bind(to, kind).first<{ n: number }>())!.n;

describe('sendSchedulingRequest', () => {
  it('emails the assignee, stamps notified_at, and mints a respond token', async () => {
    await sendSchedulingRequest(ENV, env.DB, 1);
    expect(await logCount('vol@example.com', 'request')).toBe(1);
    const a = await env.DB.prepare(`SELECT notified_at FROM roster_assignments WHERE id = 1`).first<{ notified_at: string | null }>();
    expect(a?.notified_at).not.toBeNull();
    const tok = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tokens WHERE person_id = 2 AND purpose = 'respond' AND assignment_id = 1`).first<{ n: number }>();
    expect(tok!.n).toBe(1);
  });
});

describe('sendDeclineNotice', () => {
  it('notifies the team leaders', async () => {
    await sendDeclineNotice(ENV, env.DB, 1, 'out of town');
    expect(await logCount('leader@example.com', 'decline')).toBe(1);
  });
});

describe('sendApplicationReceived', () => {
  it('notifies the team leaders', async () => {
    await sendApplicationReceived(ENV, env.DB, 1);
    expect(await logCount('leader@example.com', 'appReceived')).toBe(1);
  });
});

describe('sendApplicationResult', () => {
  it('emails the applicant', async () => {
    await sendApplicationResult(ENV, env.DB, 1, true);
    expect(await logCount('app@example.com', 'appResult')).toBe(1);
  });
});

describe('sendServeInvite', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO people (id, display_name, email, lang, active) VALUES
        (20, 'Invitee', 'invitee@example.com', 'en', 1),
        (21, 'Inactive', 'inactive@example.com', 'en', 0),
        (22, 'NoEmail', '', 'zh', 1),
        (23, '恩慈', 'zh.invitee@example.com', 'zh', 1)`),
      env.DB.prepare(`INSERT INTO team_i18n (team_id, locale, name) VALUES (1, 'zh', '敬拜队')`),
    ]);
  });

  it('emails an active invitee and logs an outreach devlog row', async () => {
    expect(await sendServeInvite(ENV, env.DB, { personId: 20, teamId: 1, invitedByEmail: 'admin@example.com' })).toBe(true);
    expect(await logCount('invitee@example.com', 'outreach')).toBe(1);
  });

  it('resolves the team name in the recipient language (zh)', async () => {
    // Devlog mode prints the full mail via console.log (mocked in beforeAll) —
    // capture it to assert the zh team name reached the zh recipient's body.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logSpy.mockClear();
    expect(await sendServeInvite(ENV, env.DB, { personId: 23, teamId: 1, invitedByEmail: 'x' })).toBe(true);
    const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('zh.invitee@example.com');
    expect(logged).toContain('敬拜队'); // zh team name, not the en fallback
    expect(logged).not.toContain('Worship');
  });

  it('returns false and sends nothing for an inactive person', async () => {
    expect(await sendServeInvite(ENV, env.DB, { personId: 21, teamId: 1, invitedByEmail: 'x' })).toBe(false);
    expect(await logCount('inactive@example.com', 'outreach')).toBe(0);
  });

  it('returns false when the person has no email', async () => {
    expect(await sendServeInvite(ENV, env.DB, { personId: 22, teamId: 1, invitedByEmail: 'x' })).toBe(false);
  });

  it('returns false when the team is gone', async () => {
    expect(await sendServeInvite(ENV, env.DB, { personId: 20, teamId: 999, invitedByEmail: 'x' })).toBe(false);
  });
});

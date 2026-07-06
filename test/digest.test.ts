// Weekly digest + daily reminders (workers project, migrated D1). Migration 0002
// seeds the rules (remind7=1, remind3=0, digestAM=1). Ported from the reference stack's
// digest test, adapted to church-cms (emails are NOT NULL, so the excluded cases
// use a declined / inactive / out-of-window assignment instead of a null email).
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sendReminders, sendWeeklyDigest } from '../src/lib/digest';
import { sendEmail } from '../src/lib/email';
import { setRule } from '../src/lib/emailSettingsDb';

// Spy on sendEmail (keeping the real devlog implementation) so the HTML body of
// each dev-sent message can be asserted — email_log does not store the body.
vi.mock('../src/lib/email', { spy: true });

// Fixed "now": Wednesday 2030-06-05 in Chicago → 7-day window [06-05, 06-12).
const NOW = new Date('2030-06-05T12:00:00-05:00');
const ENV = { EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' };

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people (id, display_name, email, lang, active) VALUES
      (1, 'A', 'a@example.com', 'en', 1),
      (2, 'B', 'b@example.com', NULL, 1),
      (4, 'D', 'd@example.com', NULL, 1),
      (5, 'Inactive', 'e@example.com', NULL, 0)`),
    env.DB.prepare(`INSERT INTO teams (id) VALUES (1)`),
    env.DB.prepare(`INSERT INTO team_i18n (team_id, locale, name) VALUES (1, 'en', 'Worship')`),
    env.DB.prepare(`INSERT INTO positions (id, team_id) VALUES (1, 1), (2, 1)`),
    // Position 2 carries markup in its name — the HTML-escaping probe.
    env.DB.prepare(`INSERT INTO position_i18n (position_id, locale, name) VALUES (1, 'en', 'Vocalist'), (2, 'en', '<b>X</b>')`),
    env.DB.prepare(`INSERT INTO service_types (id) VALUES (1), (2)`),
    env.DB.prepare(`INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES (1, 'en', 'Chinese'), (2, 'en', 'Reminders')`),
    env.DB.prepare(`INSERT INTO plans (id, service_type_id, plan_date) VALUES
      (1, 1, '2030-06-05'), (2, 1, '2030-06-09'), (3, 1, '2030-06-11'), (4, 1, '2030-06-12'), (5, 1, '2030-06-20'),
      (100, 2, '2030-06-12'), (101, 2, '2030-06-08')`),
    env.DB.prepare(`INSERT INTO roster_assignments (plan_id, position_id, person_id, status) VALUES
      (1, 1, 1, 'C'),   -- A: start edge, included
      (2, 1, 1, 'U'),   -- A: unconfirmed, still in window
      (2, 1, 2, 'D'),   -- B: declined, excluded entirely
      (2, 1, 5, 'C'),   -- inactive, excluded
      (5, 1, 1, 'C'),   -- A: outside window, excluded
      (3, 1, 4, 'C'),   -- D: 06-11, last day in window, included
      (4, 1, 4, 'C'),   -- D also on 06-12 = start+7: excluded
      (100, 1, 1, 'U'), -- reminders: exactly 7 days out
      (101, 1, 1, 'U'), -- reminders: exactly 3 days out
      (2, 2, 1, 'C')    -- A: in window on the markup-named position (escaping probe)
    `),
  ]);
});

describe('sendWeeklyDigest', () => {
  it('emails only people with non-declined assignments in the 7-day window', async () => {
    const sent = await sendWeeklyDigest(ENV, env.DB, NOW);
    expect(sent.sort()).toEqual(['a@example.com', 'd@example.com']);
  });

  it('HTML-escapes leader-editable names in the HTML body (plain text stays raw)', async () => {
    vi.mocked(sendEmail).mockClear();
    await sendWeeklyDigest(ENV, env.DB, NOW);
    const call = vi.mocked(sendEmail).mock.calls.find(([, , msg]) => msg.to === 'a@example.com');
    expect(call).toBeDefined();
    const msg = call![2];
    // Position 2 is named '<b>X</b>': escaped in the HTML branch, raw in text.
    expect(msg.html).toContain('&lt;b&gt;X&lt;/b&gt;');
    expect(msg.html).not.toContain('<b>X</b>');
    expect(msg.text).toContain('<b>X</b>');
  });

  it('is gated by the digestAM rule', async () => {
    await setRule(env.DB, 'digestAM', false);
    expect(await sendWeeklyDigest(ENV, env.DB, NOW)).toEqual([]);
  });
});

describe('sendReminders', () => {
  it('honors remind7 on / remind3 off and re-sends only the exactly-N-days-out U requests', async () => {
    // Seeded defaults: remind7=1, remind3=0 → only the 7-day-out request goes.
    expect(await sendReminders(ENV, env.DB, NOW)).toBe(1);

    const sevenDay = await env.DB.prepare(`SELECT notified_at FROM roster_assignments WHERE plan_id = 100`).first<{ notified_at: string | null }>();
    const threeDay = await env.DB.prepare(`SELECT notified_at FROM roster_assignments WHERE plan_id = 101`).first<{ notified_at: string | null }>();
    expect(sevenDay?.notified_at).not.toBeNull();
    expect(threeDay?.notified_at).toBeNull();

    // Turning remind3 on adds the 3-day pass (the 7-day one is still U → re-sent).
    await setRule(env.DB, 'remind3', true);
    expect(await sendReminders(ENV, env.DB, NOW)).toBe(2);
  });

  it('sends nothing when both reminder rules are off', async () => {
    await setRule(env.DB, 'remind7', false);
    await setRule(env.DB, 'remind3', false);
    expect(await sendReminders(ENV, env.DB, NOW)).toBe(0);
  });
});

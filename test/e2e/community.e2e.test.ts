import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
async function cookie(id: number, email: string) {
  const token = await mintSession(
    (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET,
    { id, email, sessionEpoch: 0 },
  );
  return `${SESSION_COOKIE}=${token}; c4c_campus=main`;
}
describe('community management in the built Worker', () => {
  it('renders campus management and workflows for a groups administrator', async () => {
    const admin = await cookie(1, 'admin@example.com');
    for (const path of [
      '/admin/community',
      '/admin/workflows',
      '/admin/groups',
    ]) {
      const res = await get(path, { cookie: admin });
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html).toContain('Workflows');
      expect(html).toContain('Campus');
    }
  });
  it('creates a fellowship and supports assigning a group back to the campus', async () => {
    const admin = await cookie(1, 'admin@example.com');
    const created = await post(
      '/admin/community',
      'action=save&name=Neighborhood+Fellowship&slug=neighborhood&description=Growing+together&coordinator_id=1',
      { cookie: admin },
    );
    expect(created.status).toBe(303);
    const row = await env.DB.prepare(
      "SELECT id FROM fellowships WHERE slug='neighborhood'",
    ).first<{ id: number }>();
    expect(row).not.toBeNull();
    expect(
      (
        await post(
          `/admin/community?fellowship=${row!.id}`,
          `action=group&group_id=1&fellowship_id=${row!.id}`,
          { cookie: admin },
        )
      ).status,
    ).toBe(303);
    expect(
      (await get(`/admin/community?fellowship=${row!.id}`, { cookie: admin }))
        .status,
    ).toBe(200);
    expect(
      (
        await post(
          '/admin/community',
          'action=group&group_id=1&fellowship_id=',
          { cookie: admin },
        )
      ).status,
    ).toBe(303);
    expect(
      await env.DB.prepare(
        'SELECT group_id FROM fellowship_groups WHERE group_id=1',
      ).first(),
    ).toBeNull();
  });
  it('creates a direct-campus workflow, renders the assignee form, and saves completion', async () => {
    const admin = await cookie(1, 'admin@example.com');
    const template = await post(
      '/admin/workflows',
      'action=template&name=Campus+welcome&trigger=manual&enabled=on&step_title=Welcome+contact&step_days=0',
      { cookie: admin },
    );
    expect(template.status).toBe(303);
    const row = await env.DB.prepare(
      "SELECT id FROM workflow_templates WHERE name='Campus welcome'",
    ).first<{ id: number }>();
    const form = new URLSearchParams({
      action: 'start',
      template_id: String(row!.id),
      person_id: '8',
      assignee_id: '8',
      request_key: crypto.randomUUID(),
      start_at: '2026-09-16T15:00',
    });
    expect(
      (await post('/admin/workflows', form.toString(), { cookie: admin }))
        .status,
    ).toBe(303);
    const member = await cookie(8, 'ben.wu@example.com');
    const page = await get('/en/my/workflows', { cookie: member });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Welcome contact');
    const task = await env.DB.prepare(
      "SELECT id FROM workflow_tasks WHERE title='Welcome contact'",
    ).first<{ id: string }>();
    const response = await post(
      '/en/my/workflows',
      new URLSearchParams({
        action: 'task',
        task_id: task!.id,
        status: 'completed',
        notes: 'Contact made.',
      }).toString(),
      { cookie: member },
    );
    expect(response.status).toBe(303);
    expect(
      await env.DB.prepare('SELECT status FROM workflow_tasks WHERE id=?')
        .bind(task!.id)
        .first(),
    ).toEqual({ status: 'completed' });
  });
  it('denies member admin access and rejects cross-origin writes', async () => {
    const member = await cookie(8, 'ben.wu@example.com');
    expect((await get('/admin/community', { cookie: member })).status).toBe(
      403,
    );
    expect((await get('/admin/workflows', { cookie: member })).status).toBe(
      403,
    );
    const admin = await cookie(1, 'admin@example.com');
    expect(
      (
        await post(
          '/admin/community',
          'action=save&name=Rejected&slug=rejected',
          { cookie: admin, origin: 'https://other.example' },
        )
      ).status,
    ).toBe(403);
  });
});

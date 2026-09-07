import { describe, expect, it } from 'vitest';
import { enqueueDuePlanningCenterSyncJobs, planningCenterCredentials } from '../../src/lib/planningCenterSync';
import { parseDevVars } from '../../scripts/setup/secrets.mjs';

describe('Planning Center sync configuration', () => {
  it('requires the complete Worker-secret credential pair and identifying User-Agent', () => {
    expect(planningCenterCredentials({
      PLANNING_CENTER_CLIENT_ID: 'client_test',
      PLANNING_CENTER_SECRET: 'secret_test',
      PLANNING_CENTER_WEBHOOK_SECRET: 'webhook_test_secret',
      PLANNING_CENTER_USER_AGENT: 'Church CMS <https://church.example/contact>',
    })).toEqual({ clientId: 'client_test', secret: 'secret_test', webhookSecret: 'webhook_test_secret', userAgent: 'Church CMS <https://church.example/contact>' });
    expect(() => planningCenterCredentials({ PLANNING_CENTER_CLIENT_ID: 'client_test' })).toThrow('planning_center_credentials_incomplete');
  });

  it('uses the runtime 16-character minimum for setup webhook secrets', () => {
    expect(() => parseDevVars('PLANNING_CENTER_WEBHOOK_SECRET=123456789012345\n')).toThrow(/16/);
    expect(parseDevVars('PLANNING_CENTER_WEBHOOK_SECRET=1234567890123456\n').get('PLANNING_CENTER_WEBHOOK_SECRET')).toBe('1234567890123456');
    expect(() => planningCenterCredentials({
      PLANNING_CENTER_CLIENT_ID: 'client_test',
      PLANNING_CENTER_SECRET: 'secret_test',
      PLANNING_CENTER_WEBHOOK_SECRET: '1234567890123456',
      PLANNING_CENTER_USER_AGENT: 'Church CMS <https://church.example/contact>',
    })).not.toThrow();
  });
});

describe('Planning Center scheduler timestamp portability', () => {
  it('accepts a PostgreSQL Date value when deciding whether a connection is due', async () => {
    const bindings: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) { bindings.push([sql, ...values]); return this; },
          async all() { return { results: [{ id: 42, last_success_at: new Date('2031-01-01T00:00:00Z') }], meta: { changes: 0 } }; },
          async run() { return { results: [], meta: { changes: 1 } }; },
          async first() { return null; },
        };
      },
      async batch() { return []; },
    };
    await expect(enqueueDuePlanningCenterSyncJobs(db as never, new Date('2031-01-01T00:30:00Z'))).resolves.toBe(0);
    expect(bindings).toHaveLength(1);
    expect(bindings[0][1]).toBe('2030-12-31 23:30:00');
  });
});

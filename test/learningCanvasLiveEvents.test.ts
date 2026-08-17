import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  acceptCanvasLiveEvent,
  finishCanvasLiveEvent,
  LearningCanvasLiveEventConflictError,
  LearningCanvasLiveEventError,
  verifyCanvasLiveEventJwt,
} from '../src/lib/learningCanvasLiveEvents';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const BASE_URL = 'https://canvas.church.example';

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metadata: {
      producer: 'canvas', root_account_id: 'root-1',
      root_account_lti_guid: 'opaque.canvas.church.example',
      context_type: 'Course', context_id: 'course-1',
      event_name: 'assignment_updated', event_time: '2026-08-17T11:59:59.000Z',
      request_id: 'request-shared-by-several-events',
    },
    body: {
      course_id: 'course-1', assignment_id: 'assignment-1',
      grade: 'A', answer: 'private answer', comment: 'private comment',
    },
    ...overrides,
  };
}

describe('Canvas signed Live Events boundary', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM learning_provider_connections WHERE id=28202').run();
    await env.DB.prepare('DELETE FROM learning_programs WHERE id=28203').run();
    await env.DB.prepare('DELETE FROM people WHERE id=28201').run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(28201,'Canvas Admin','canvas-live@example.test')").run();
    await env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(28202,'canvas','Canvas',?1,'active',1,28201)`).bind(BASE_URL).run();
    await env.DB.prepare("INSERT INTO learning_programs(id,slug,display_name) VALUES(28203,'canvas-live','Canvas Live')").run();
    await env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url)
      VALUES(28204,28203,28202,'canvas','course-1','Canvas course',?1)`)
      .bind(`${BASE_URL}/courses/course-1`).run();
    await env.DB.prepare(`INSERT INTO learning_canvas_webhook_configs
      (connection_id,root_account_id) VALUES(28202,'root-1')`).run();
  });

  it('verifies only an RS256 compact JWT and emits a privacy-safe reconcile notification', async () => {
    const verifyToken = vi.fn(async () => ({ payload: claims() }));
    const event = await verifyCanvasLiveEventJwt({
      compactJwt: 'eyJraWQiOiJrMSIsImFsZyI6IlJTMjU2In0.eyJldmVudCI6MX0.signature',
      receivedAt: new Date(NOW).toISOString(), verifyToken,
    });
    expect(verifyToken).toHaveBeenCalledWith(expect.any(String), {
      algorithms: ['RS256'], jwkSetUrl: 'https://8axpcl50e4.execute-api.us-east-1.amazonaws.com/main/jwks',
    });
    expect(event).toEqual({
      sourceEventId: expect.stringMatching(/^sha256:[A-Za-z0-9_-]{43}$/u),
      rootAccountId: 'root-1', sourceHostname: 'canvas.church.example',
      externalCourseId: 'course-1', eventName: 'assignment_updated',
      eventTime: '2026-08-17T11:59:59.000Z', receivedAt: '2026-08-17T12:00:00.000Z',
    });
    expect(JSON.stringify(event)).not.toMatch(/grade|answer|comment|assignment-1|request-shared/iu);
  });

  it('rejects unsigned, malformed, irrelevant, ambiguous-course, or unverified events', async () => {
    const token = 'eyJraWQiOiJrMSIsImFsZyI6IlJTMjU2In0.e30.signature';
    for (const payload of [
      claims({ metadata: { ...(claims().metadata as object), producer: 'other' } }),
      claims({ metadata: { ...(claims().metadata as object), event_name: 'grade_change' } }),
      claims({ body: { course_id: 'different-course' } }),
      claims({ metadata: { ...(claims().metadata as object), hostname: 'attacker.example', root_account_lti_guid: undefined } }),
    ]) {
      await expect(verifyCanvasLiveEventJwt({
        compactJwt: token, receivedAt: new Date(NOW).toISOString(),
        verifyToken: async () => ({ payload }),
      })).rejects.toBeInstanceOf(LearningCanvasLiveEventError);
    }
    await expect(verifyCanvasLiveEventJwt({
      compactJwt: token, receivedAt: new Date(NOW).toISOString(),
      verifyToken: async () => { throw new Error('bad signature'); },
    })).rejects.toBeInstanceOf(LearningCanvasLiveEventError);
    for (const compactJwt of ['', 'not-a-jwt', `${'a'.repeat(65_537)}.b.c`]) {
      await expect(verifyCanvasLiveEventJwt({
        compactJwt, receivedAt: new Date(NOW).toISOString(),
        verifyToken: async () => ({ payload: claims() }),
      })).rejects.toBeInstanceOf(LearningCanvasLiveEventError);
    }
  });

  it('binds the signed account, hostname, and mapped course before claiming a payload-free receipt', async () => {
    const event = await verifyCanvasLiveEventJwt({
      compactJwt: 'eyJraWQiOiJrMSIsImFsZyI6IlJTMjU2In0.e30.signature',
      receivedAt: new Date(NOW).toISOString(), verifyToken: async () => ({ payload: claims() }),
    });
    const accepted = await acceptCanvasLiveEvent(env.DB as AppDb, event);
    expect(accepted).toEqual(expect.objectContaining({
      connectionId: 28202, externalCourseId: 'course-1', disposition: 'claimed', attemptCount: 1,
    }));
    const row = await env.DB.prepare(`SELECT connection_id,source_event_id,external_course_id,event_name,
      status,attempt_count,claim_marker,claim_expires_at,completed_at
      FROM learning_canvas_event_receipts WHERE connection_id=28202`).first<Record<string, unknown>>();
    expect(row).toEqual(expect.objectContaining({
      connection_id: 28202, external_course_id: 'course-1', event_name: 'assignment_updated',
      status: 'pending', attempt_count: 1,
    }));
    expect(Object.keys(row ?? {})).not.toContain('payload');
    expect(JSON.stringify(row)).not.toMatch(/grade|answer|comment|private/iu);

    await finishCanvasLiveEvent(env.DB as AppDb, {
      receipt: accepted, outcome: 'succeeded', completedAt: '2026-08-17T12:00:01.000Z',
    });
    expect((await acceptCanvasLiveEvent(env.DB as AppDb, event)).disposition).toBe('succeeded');
  });

  it('is retry-safe after failure or stale claims and rejects losing finalizers', async () => {
    const event = await verifyCanvasLiveEventJwt({
      compactJwt: 'eyJraWQiOiJrMSIsImFsZyI6IlJTMjU2In0.e30.retry-signature',
      receivedAt: new Date(NOW).toISOString(), verifyToken: async () => ({ payload: claims() }),
    });
    const first = await acceptCanvasLiveEvent(env.DB as AppDb, event);
    await finishCanvasLiveEvent(env.DB as AppDb, {
      receipt: first, outcome: 'failed', completedAt: '2026-08-17T12:00:01.000Z',
    });
    const retried = await acceptCanvasLiveEvent(env.DB as AppDb, {
      ...event, receivedAt: '2026-08-17T12:00:02.000Z',
    });
    expect(retried).toEqual(expect.objectContaining({ disposition: 'claimed', attemptCount: 2 }));
    await expect(finishCanvasLiveEvent(env.DB as AppDb, {
      receipt: first, outcome: 'succeeded', completedAt: '2026-08-17T12:00:03.000Z',
    })).rejects.toBeInstanceOf(LearningCanvasLiveEventConflictError);
    await env.DB.prepare(`UPDATE learning_canvas_event_receipts
      SET claim_expires_at='2026-08-17T12:00:03.000Z' WHERE connection_id=28202`).run();
    const reclaimed = await acceptCanvasLiveEvent(env.DB as AppDb, {
      ...event, receivedAt: '2026-08-17T12:00:04.000Z',
    });
    expect(reclaimed).toEqual(expect.objectContaining({ disposition: 'claimed', attemptCount: 3 }));
  });

  it('rejects events outside the exact configured account, base hostname, or active mapped course', async () => {
    for (const patch of [
      { rootAccountId: 'root-other' },
      { sourceHostname: 'other.example' },
      { externalCourseId: 'course-other' },
    ]) {
      await expect(acceptCanvasLiveEvent(env.DB as AppDb, {
        sourceEventId: `sha256:${'a'.repeat(43)}`, rootAccountId: 'root-1',
        sourceHostname: 'canvas.church.example', externalCourseId: 'course-1',
        eventName: 'assignment_updated', eventTime: '2026-08-17T11:59:59.000Z',
        receivedAt: '2026-08-17T12:00:00.000Z', ...patch,
      })).rejects.toBeInstanceOf(LearningCanvasLiveEventError);
    }
  });
});

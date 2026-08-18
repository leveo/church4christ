import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import { encodeCanvasCredential } from '../src/lib/learningCanvasAuth';
import { CANVAS_REQUIRED_SCOPES } from '../src/lib/learningCanvasProvider';
import { reconcileCanvasCourse } from '../src/lib/learningCanvasReconcile';
import { encryptLearningCredential, importLearningCredentialKeyRing } from '../src/lib/learningCredentials';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');
const BASE_URL = 'https://canvas-refresh.test';
const KEY_SECRET = JSON.stringify({
  currentVersion: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(83))) },
});

describe('Canvas authoritative course reconciliation refresh classification', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM learning_sync_runs WHERE connection_id=31202').run();
    await env.DB.prepare('DELETE FROM learning_courses WHERE connection_id=31202').run();
    await env.DB.prepare('DELETE FROM learning_provider_connections WHERE id=31202').run();
    await env.DB.prepare('DELETE FROM learning_programs WHERE id=31203').run();
    await env.DB.prepare('DELETE FROM people WHERE id=31201').run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(31201,'Canvas Sync Admin','canvas-sync@example.test')").run();
    await env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(31202,'canvas','Canvas Refresh',?1,'active',1,31201)`).bind(BASE_URL).run();
    await env.DB.prepare("INSERT INTO learning_programs(id,slug,display_name) VALUES(31203,'canvas-refresh','Canvas Refresh')").run();
    await env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url)
      VALUES(31204,31203,31202,'canvas','course-1','Canvas course',?1)`)
      .bind(`${BASE_URL}/courses/course-1`).run();
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const envelope = await encryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 31202,
      plaintext: encodeCanvasCredential({
        version: 1, accessToken: 'expired-access', refreshToken: 'private-refresh',
        accessTokenExpiresAt: '2026-08-18T11:00:00.000Z', grantedScopes: CANVAS_REQUIRED_SCOPES,
      }), expiresAt: null,
    });
    await env.DB.prepare(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES(31202,?1,?2,?3,?4,?5,NULL)`).bind(
      envelope.ciphertext, envelope.nonce, envelope.algorithm,
      envelope.keyVersion, envelope.envelopeVersion,
    ).run();
  });

  it.each([
    [429, '9', 'rate_limited', 9],
    [502, null, 'provider_unavailable', null],
    [400, null, 'authentication_required', null],
    [403, null, 'permission_denied', null],
  ] as const)('preserves production OAuth refresh status %s for Task 10 retry/reconnect', async (
    status, retryAfter, code, retryAfterSeconds,
  ) => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${BASE_URL}/login/oauth2/token`);
      return new Response(null, {
        status,
        headers: retryAfter === null ? undefined : { 'Retry-After': retryAfter },
      });
    });
    await expect(reconcileCanvasCourse(env.DB as AppDb, {
      connectionId: 31202, externalCourseId: 'course-1', trigger: 'notification',
      clientId: 'canvas-client', clientSecret: 'private-client-secret',
      allowedOrigins: Object.freeze([BASE_URL]), keyRing: ring, fetcher,
      now: () => NOW, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code, provider: 'canvas', httpStatus: status, retryAfterSeconds });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

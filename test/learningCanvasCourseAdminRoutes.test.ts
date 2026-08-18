import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../src/lib/types';
import { createCanvasCourseMappingHandler } from '../src/pages/admin/learning/canvas/map-course';

function user(): SessionUser {
  return {
    id: 71, email: 'canvas@example.test', displayName: 'Canvas Admin', role: 'admin',
    isAdmin: true, isEditor: false, finance: 0, memberTeamIds: [], leaderTeamIds: [],
    lang: 'en', isSuperAdmin: false, adminAreas: ['learning'],
  };
}

function context(body: URLSearchParams, origin = 'https://church.test'): never {
  const request = new Request('https://church.test/admin/learning/canvas/map-course', {
    method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  return {
    request, url: new URL(request.url),
    locals: { modules: new Set(['learning']), user: user(), db: {} },
  } as never;
}

const deps = () => ({
  mapCourse: vi.fn(async () => undefined),
  unmapCourse: vi.fn(async () => undefined),
});

describe('Canvas mapped-course admin route', () => {
  it('maps with exact revision, program, and course fields while deriving the root account from Canvas', async () => {
    const injected = deps();
    const response = await createCanvasCourseMappingHandler(injected)(context(new URLSearchParams({
      action: 'map', connection_id: '81', revision: '4', external_course_id: '901',
      program_id: '33',
    })));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/learning/canvas/courses?connection_id=81&saved=course_mapped');
    expect(injected.mapCourse).toHaveBeenCalledWith({}, {
      connectionId: 81, expectedRevision: 4, externalCourseId: '901',
      programId: 33, actorPersonId: 71, signal: expect.any(AbortSignal),
    });
  });

  it('unmaps with CAS and rejects cross-origin, duplicate, unknown, or token-bearing forms', async () => {
    const injected = deps();
    const response = await createCanvasCourseMappingHandler(injected)(context(new URLSearchParams({
      action: 'unmap', connection_id: '81', revision: '5', external_course_id: '901',
    })));
    expect(response.headers.get('location')).toBe('/admin/learning/canvas/courses?connection_id=81&saved=course_unmapped');
    expect(injected.unmapCourse).toHaveBeenCalledWith({}, {
      connectionId: 81, expectedRevision: 5, externalCourseId: '901', actorPersonId: 71,
      signal: expect.any(AbortSignal),
    });
    for (const [body, origin] of [
      [new URLSearchParams({ action: 'unmap', connection_id: '81', revision: '5', external_course_id: '901' }), 'https://evil.test'],
      [new URLSearchParams({ action: 'map', connection_id: '81', revision: '5', external_course_id: '901', program_id: '33', root_account_id: 'root', access_token: 'private' }), 'https://church.test'],
      [new URLSearchParams('action=unmap&connection_id=81&connection_id=82&revision=5&external_course_id=901'), 'https://church.test'],
    ] as const) {
      const rejected = await createCanvasCourseMappingHandler(deps())(context(body, origin));
      expect(rejected.status).toBe(origin === 'https://evil.test' ? 403 : 303);
      expect(rejected.headers.get('location') ?? '').not.toMatch(/private|token/iu);
    }
  });
});

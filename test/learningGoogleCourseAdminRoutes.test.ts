import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../src/lib/types';
import { createGoogleCourseMappingHandler } from '../src/pages/admin/learning/google/map-course';

function user(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 91, email: 'learning@example.test', displayName: 'Learning Admin', role: 'admin',
    isAdmin: true, isEditor: false, finance: 0, memberTeamIds: [], leaderTeamIds: [],
    lang: 'en', isSuperAdmin: false, adminAreas: ['learning'], ...over,
  };
}

function context(request: Request, modules = ['learning'], actor: SessionUser | null = user()): never {
  return { request, url: new URL(request.url), locals: { modules: new Set(modules), user: actor, db: {} } } as never;
}

const deps = () => ({
  mapSelectedCourse: vi.fn(async () => ({
    courseId: 801, programId: 31, connectionId: 73, provider: 'google_classroom' as const,
    externalCourseId: 'course-1', displayName: 'Genesis 1', lifecycleState: 'active' as const, lastSyncedAt: null,
  })),
});

describe('Google Classroom mapped-course action', () => {
  it('checks module, Learning area, method, and CSRF before reading body or provider credentials', async () => {
    let pulled = false;
    const request = new Request('https://church.test/admin/learning/google/map-course', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new ReadableStream({ pull() { pulled = true; throw new Error('body read'); } }, { highWaterMark: 0 }),
    });
    const injected = deps();
    expect((await createGoogleCourseMappingHandler(injected)(context(request, []))).status).toBe(404);
    expect((await createGoogleCourseMappingHandler(injected)(context(request, ['learning'], user({ adminAreas: [] })))).status).toBe(403);
    expect((await createGoogleCourseMappingHandler(injected)(context(request))).status).toBe(403);
    expect(pulled).toBe(false);
    expect(injected.mapSelectedCourse).not.toHaveBeenCalled();
  });

  it('accepts only bounded IDs and maps authoritative provider data under the selected program', async () => {
    const injected = deps();
    const request = new Request('https://church.test/admin/learning/google/map-course', {
      method: 'POST', headers: {
        'content-type': 'application/x-www-form-urlencoded', origin: 'https://church.test',
      }, body: 'connection_id=73&external_course_id=course-1&program_id=31',
    });
    const response = await createGoogleCourseMappingHandler(injected)(context(request));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/learning/google/courses?connection_id=73&saved=course_mapped');
    expect(injected.mapSelectedCourse).toHaveBeenCalledWith({}, {
      connectionId: 73, externalCourseId: 'course-1', programId: 31, actorPersonId: 91,
    });
    expect(JSON.stringify(injected.mapSelectedCourse.mock.calls)).not.toMatch(/Genesis|launchUrl|accessToken|refreshToken/iu);
  });

  it('rejects duplicate/unknown fields and provider failures through a fixed bilingual-safe redirect', async () => {
    const injected = deps();
    injected.mapSelectedCourse.mockRejectedValue(new Error('private-access provider body'));
    for (const body of [
      'connection_id=73&external_course_id=course-1&program_id=31&title=hostile',
      'connection_id=73&connection_id=74&external_course_id=course-1&program_id=31',
      'connection_id=73&external_course_id=course-1&program_id=31',
    ]) {
      const response = await createGoogleCourseMappingHandler(injected)(context(new Request(
        'https://church.test/admin/learning/google/map-course', {
          method: 'POST', headers: {
            'content-type': 'application/x-www-form-urlencoded', origin: 'https://church.test',
          }, body,
        },
      )));
      expect(response.headers.get('location')).toBe('/admin/learning/google/courses?connection_id=73&error=course_mapping_failed');
      expect(response.headers.get('location')).not.toMatch(/private|provider|body/iu);
    }
  });
});

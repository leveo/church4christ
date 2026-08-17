import { describe, expect, it, vi } from 'vitest';
import {
  LearningProviderError,
  learningSyntheticEnrollmentId,
  type LearningConnectionUrlPolicy,
} from '../src/lib/learningModel';
import { invokeLearningProvider, type LearningOperationContext } from '../src/lib/learningProvider';
import {
  createGoogleClassroomProvider,
  type GoogleClassroomProviderDependencies,
} from '../src/lib/learningGoogleProvider';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const CONNECTION_ID = 371;
const POLICY: LearningConnectionUrlPolicy = Object.freeze({
  connectionId: CONNECTION_ID,
  provider: 'google_classroom',
  baseUrl: null,
  providerLaunchOrigins: Object.freeze(['https://classroom.google.com']),
  providerFileOrigins: Object.freeze(['https://drive.google.com', 'https://docs.google.com']),
  externalLinkOrigins: Object.freeze(['https://forms.gle', 'https://resources.example.test']),
});

function operation(
  externalCourseId: string | null,
  externalActivityId: string | null = null,
  externalEnrollmentId: string | null = null,
): LearningOperationContext {
  return Object.freeze({
    scope: Object.freeze({
      connectionId: CONNECTION_ID, provider: 'google_classroom' as const,
      externalCourseId, externalActivityId, externalEnrollmentId,
    }),
    startedAt: '2026-08-17T12:00:00.000Z', deadlineAt: '2026-08-17T12:01:00.000Z',
    maxPages: 20, maxItems: 1_000, maxRawBytes: 10_485_760,
    maxNormalizedBytes: 10_485_760, maxUniqueKeyBytes: 1_048_576,
    signal: new AbortController().signal,
  });
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function provider(fetcher: GoogleClassroomProviderDependencies['fetcher']) {
  return createGoogleClassroomProvider({
    connectionId: CONNECTION_ID,
    accessToken: 'private-access-token',
    urlPolicy: POLICY,
    fetcher,
    now: () => NOW + 1,
  });
}

describe('Google Classroom provider adapter', () => {
  it('reads one mapped course through the course-scoped bounded response contract', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v1/courses/123');
      expect(url.searchParams.get('fields')).toBe('id,name,courseState,alternateLink,updateTime');
      return json({
        id: '123', name: 'Genesis 1', courseState: 'ACTIVE',
        alternateLink: 'https://classroom.google.com/c/123',
        updateTime: '2026-08-17T11:00:00.000Z',
      });
    });
    const result = await invokeLearningProvider(provider(fetcher), {
      method: 'syncCourse',
      request: {
        subject: { connectionId: CONNECTION_ID, provider: 'google_classroom', externalCourseId: '123' },
        operation: operation('123'),
      },
      urlPolicy: POLICY,
      now: () => NOW + 1,
    });
    expect(result).toMatchObject({
      externalCourseId: '123', displayName: 'Genesis 1', lifecycleState: 'active',
    });
  });

  it('lists only bounded course metadata and carries the opaque page token without changing filters', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://classroom.googleapis.com');
      expect(url.pathname).toBe('/v1/courses');
      expect(url.searchParams.getAll('courseStates')).toEqual(['ACTIVE', 'ARCHIVED']);
      expect(url.searchParams.get('pageSize')).toBe('100');
      expect(url.searchParams.get('fields')).toBe('courses(id,name,courseState,alternateLink,updateTime),nextPageToken');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-access-token');
      return json({
        courses: [{
          id: '123', name: 'Genesis 1', courseState: 'ACTIVE',
          alternateLink: 'https://classroom.google.com/c/123', updateTime: '2026-08-17T11:00:00.000Z',
        }],
        nextPageToken: 'opaque-token',
      });
    });
    const result = await invokeLearningProvider(provider(fetcher), {
      method: 'listCourses',
      request: {
        subject: { connectionId: CONNECTION_ID, provider: 'google_classroom' },
        page: { pageSize: 100, pageNumber: 1, pageToken: null },
        operation: operation(null),
      },
      urlPolicy: POLICY,
      now: () => NOW + 1,
    });
    expect(result.items).toEqual([{
      connectionId: CONNECTION_ID, provider: 'google_classroom', externalCourseId: '123',
      displayName: 'Genesis 1', launchUrl: 'https://classroom.google.com/c/123',
      lifecycleState: 'active', providerUpdatedAt: '2026-08-17T11:00:00.000Z', lastSyncedAt: null,
    }]);
    expect(result.nextPageToken).toBe('opaque-token');
    expect(JSON.stringify(result)).not.toMatch(/private-access-token|description|owner|email/iu);
  });

  it('paginates teachers then students with stable synthetic enrollment ids and no profile data', async () => {
    const paths: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}?${url.searchParams.toString()}`);
      if (url.pathname.endsWith('/teachers')) return json({ teachers: [{ courseId: '123', userId: 'teacher-1' }] });
      return json({ students: [{ courseId: '123', userId: 'student-1' }], nextPageToken: 'student-next' });
    });
    const adapter = provider(fetcher);
    const first = await invokeLearningProvider(adapter, {
      method: 'syncEnrollments',
      request: {
        subject: { connectionId: CONNECTION_ID, provider: 'google_classroom', externalCourseId: '123' },
        page: { pageSize: 100, pageNumber: 1, pageToken: null }, operation: operation('123'),
      }, now: () => NOW + 1,
    });
    expect(first.items[0]).toMatchObject({ role: 'teacher', state: 'active', externalUserId: 'teacher-1' });
    expect(first.items[0]?.externalEnrollmentId).toBe(learningSyntheticEnrollmentId({
      provider: 'google_classroom', externalCourseId: '123', externalUserId: 'teacher-1',
    }));
    expect(first.nextPageToken).toMatch(/^students:/u);
    const second = await invokeLearningProvider(adapter, {
      method: 'syncEnrollments',
      request: {
        subject: { connectionId: CONNECTION_ID, provider: 'google_classroom', externalCourseId: '123' },
        page: { pageSize: 100, pageNumber: 2, pageToken: first.nextPageToken }, operation: operation('123'),
      }, now: () => NOW + 1,
    });
    expect(second.items[0]).toMatchObject({ role: 'student', state: 'active', externalUserId: 'student-1' });
    expect(second.nextPageToken).toMatch(/^students:/u);
    expect(paths.every((path) => path.includes('pageSize=100') && path.includes('fields='))).toBe(true);
    expect(JSON.stringify(second)).not.toMatch(/emailAddress|name|photoUrl/iu);
  });

  it('paginates materials then coursework and maps questions to quizzes without bodies or grades', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/courseWorkMaterials')) return json({
        courseWorkMaterial: [{
          id: 'mat-1', title: 'Creation video', state: 'PUBLISHED',
          alternateLink: 'https://classroom.google.com/c/123/m/mat-1/details',
          creationTime: '2026-08-16T12:00:00.000Z', updateTime: '2026-08-17T10:00:00.000Z',
        }],
      });
      return json({ courseWork: [{
        id: 'quiz-1', title: 'Genesis quiz', state: 'PUBLISHED', workType: 'MULTIPLE_CHOICE_QUESTION',
        alternateLink: 'https://classroom.google.com/c/123/a/quiz-1/details',
        dueDate: { year: 2026, month: 8, day: 18 }, dueTime: { hours: 15, minutes: 30 },
        creationTime: '2026-08-16T13:00:00.000Z', updateTime: '2026-08-17T11:00:00.000Z',
      }] });
    });
    const adapter = provider(fetcher);
    const first = await invokeLearningProvider(adapter, {
      method: 'syncActivities', request: {
        subject: { connectionId: CONNECTION_ID, provider: 'google_classroom', externalCourseId: '123' },
        page: { pageSize: 100, pageNumber: 1, pageToken: null }, operation: operation('123'),
      }, urlPolicy: POLICY, now: () => NOW + 1,
    });
    expect(first.items[0]).toMatchObject({ externalActivityId: 'material:mat-1', kind: 'material' });
    expect(first.nextPageToken).toMatch(/^coursework:/u);
    const second = await invokeLearningProvider(adapter, {
      method: 'syncActivities', request: {
        subject: { connectionId: CONNECTION_ID, provider: 'google_classroom', externalCourseId: '123' },
        page: { pageSize: 100, pageNumber: 2, pageToken: first.nextPageToken }, operation: operation('123'),
      }, urlPolicy: POLICY, now: () => NOW + 1,
    });
    expect(second.items[0]).toMatchObject({
      externalActivityId: 'coursework:quiz-1', kind: 'quiz', dueAt: '2026-08-18T15:30:00.000Z',
    });
    expect(JSON.stringify([...first.items, ...second.items])).not.toMatch(/description|materials|grade|answer|rubric/iu);
  });

  it('normalizes YouTube, Drive, and ordinary resources to exact launch roles without file bytes', async () => {
    const fetcher = vi.fn(async () => json({
      id: 'mat-1', title: 'Resources', state: 'PUBLISHED',
      alternateLink: 'https://classroom.google.com/c/123/m/mat-1/details',
      creationTime: '2026-08-16T12:00:00.000Z', updateTime: '2026-08-17T10:00:00.000Z',
      materials: [
        { youtubeVideo: { id: 'dQw4w9WgXcQ', title: 'Creation video', alternateLink: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
        { driveFile: { driveFile: { id: 'drive-1', title: 'Worksheet', alternateLink: 'https://drive.google.com/file/d/drive-1/view' }, shareMode: 'VIEW' } },
        { link: { url: 'https://resources.example.test/genesis', title: 'Reading' } },
      ],
    }));
    const result = await invokeLearningProvider(provider(fetcher), {
      method: 'syncResources', request: {
        subject: {
          connectionId: CONNECTION_ID, provider: 'google_classroom', externalCourseId: '123',
          externalActivityId: 'material:mat-1',
        },
        page: { pageSize: 100, pageNumber: 1, pageToken: null },
        operation: operation('123', 'material:mat-1'),
      }, urlPolicy: POLICY, now: () => NOW + 1,
    });
    expect(result.items.map((item) => item.kind).sort()).toEqual(['link', 'provider_file', 'youtube']);
    expect(result.items.find((item) => item.kind === 'youtube')).toMatchObject({
      youtubeVideoId: 'dQw4w9WgXcQ', launchUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    });
    expect(JSON.stringify(result)).not.toMatch(/thumbnail|file_bytes|content|access-token/iu);
  });

  it('normalizes submission histories without grade, answer, comment, or attachment carriers', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v1/courses/123/courseWork/quiz-1/studentSubmissions');
      expect(url.searchParams.get('fields')).not.toMatch(/grade|answer|attachment|comment/iu);
      return json({ studentSubmissions: [{
        id: 'submission-1', courseId: '123', courseWorkId: 'quiz-1', userId: 'student-1',
        state: 'RETURNED', late: true, updateTime: '2026-08-17T11:30:00.000Z',
        submissionHistory: [
          {
            stateHistory: {
              state: 'TURNED_IN', stateTimestamp: '2026-08-17T10:00:00.000Z', actorUserId: 'student-1',
            },
          },
          {
            stateHistory: {
              state: 'STUDENT_EDITED_AFTER_TURN_IN',
              stateTimestamp: '2026-08-17T10:30:00.000Z',
              actorUserId: 'student-1',
            },
          },
          {
            gradeHistory: {
              pointsEarned: 8.5, maxPoints: 10, gradeTimestamp: '2026-08-17T10:45:00.000Z',
              actorUserId: 'teacher-1', gradeChangeType: 'ASSIGNED_GRADE_POINTS_EARNED_CHANGE',
            },
          },
          {
            stateHistory: {
              state: 'RETURNED', stateTimestamp: '2026-08-17T11:00:00.000Z', actorUserId: 'teacher-1',
            },
          },
        ],
      }] });
    });
    const result = await invokeLearningProvider(provider(fetcher), {
      method: 'syncSubmissions', request: {
        subject: {
          connectionId: CONNECTION_ID, provider: 'google_classroom', externalCourseId: '123',
          externalActivityId: 'coursework:quiz-1', externalEnrollmentId: null,
        },
        page: { pageSize: 100, pageNumber: 1, pageToken: null },
        operation: operation('123', 'coursework:quiz-1'),
      }, now: () => NOW + 1,
    });
    expect(result.items[0]).toMatchObject({
      externalUserId: 'student-1', status: 'returned', late: 1, attemptNumber: 1,
      submittedAt: '2026-08-17T10:00:00.000Z', returnedAt: '2026-08-17T11:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toMatch(/submission-1|grade|answer|comment|attachment/iu);
  });

  it('rejects malformed documented submission-history unions and unknown history fields', async () => {
    const malformedHistories = [
      {
        stateHistory: { state: 'TURNED_IN', stateTimestamp: '2026-08-17T10:00:00.000Z' },
        gradeHistory: {
          pointsEarned: 8, maxPoints: 10, gradeTimestamp: '2026-08-17T10:30:00.000Z',
          actorUserId: 'teacher-1', gradeChangeType: 'ASSIGNED_GRADE_POINTS_EARNED_CHANGE',
        },
      },
      { stateHistory: { state: 'TURNED_IN', stateTimestamp: '2026-08-17T10:00:00.000Z', answer: 'private' } },
      { gradeHistory: { pointsEarned: Number.POSITIVE_INFINITY, maxPoints: 10,
        gradeTimestamp: '2026-08-17T10:30:00.000Z', actorUserId: 'teacher-1',
        gradeChangeType: 'ASSIGNED_GRADE_POINTS_EARNED_CHANGE' } },
    ];
    for (const submissionHistory of malformedHistories) {
      await expect(invokeLearningProvider(provider(async () => json({ studentSubmissions: [{
        courseId: '123', courseWorkId: 'quiz-1', userId: 'student-1', state: 'TURNED_IN',
        updateTime: '2026-08-17T11:30:00.000Z', submissionHistory: [submissionHistory],
      }] })), {
        method: 'syncSubmissions', request: {
          subject: {
            connectionId: CONNECTION_ID, provider: 'google_classroom', externalCourseId: '123',
            externalActivityId: 'coursework:quiz-1', externalEnrollmentId: null,
          },
          page: { pageSize: 100, pageNumber: 1, pageToken: null },
          operation: operation('123', 'coursework:quiz-1'),
        }, now: () => NOW + 1,
      })).rejects.toMatchObject({ code: 'malformed_response' });
    }
  });

  it('classifies auth, quota, transient, malformed, oversized, and cross-origin failures safely', async () => {
    const cases = [
      [401, {}, 'authentication_required', null],
      [403, {}, 'permission_denied', null],
      [429, { 'retry-after': '120' }, 'rate_limited', 120],
      [503, {}, 'provider_unavailable', null],
    ] as const;
    for (const [status, headers, code, retryAfterSeconds] of cases) {
      const adapter = provider(async () => json({ error: { message: 'private upstream details' } }, status, headers));
      const error = await invokeLearningProvider(adapter, {
        method: 'listCourses', request: {
          subject: { connectionId: CONNECTION_ID, provider: 'google_classroom' },
          page: { pageSize: 100, pageNumber: 1, pageToken: null }, operation: operation(null),
        }, urlPolicy: POLICY, now: () => NOW + 1,
      }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(LearningProviderError);
      expect(error).toMatchObject({ code, provider: 'google_classroom', httpStatus: status, retryAfterSeconds });
      expect(String(error)).not.toMatch(/private|upstream|access-token/iu);
    }
    const oversized = provider(async () => new Response(new Uint8Array(1_048_577), {
      headers: { 'content-length': '1048577' },
    }));
    await expect(invokeLearningProvider(oversized, {
      method: 'listCourses', request: {
        subject: { connectionId: CONNECTION_ID, provider: 'google_classroom' },
        page: { pageSize: 100, pageNumber: 1, pageToken: null }, operation: operation(null),
      }, urlPolicy: POLICY, now: () => NOW + 1,
    })).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('builds only official Classroom launch URLs and strictly normalizes reconciliation notifications', async () => {
    const adapter = provider(async () => { throw new Error('must not fetch'); });
    const launch = await invokeLearningProvider(adapter, {
      method: 'buildLaunchUrl', request: {
        subject: {
          connectionId: CONNECTION_ID, provider: 'google_classroom', externalCourseId: '123',
          externalActivityId: 'coursework:quiz-1',
        }, operation: operation('123', 'coursework:quiz-1'),
      }, urlPolicy: POLICY, now: () => NOW + 1,
    });
    expect(launch.url).toBe('https://classroom.google.com/c/123/a/quiz-1/details');
    const notification = await invokeLearningProvider(adapter, {
      method: 'normalizeNotification', request: {
        subject: { connectionId: CONNECTION_ID, provider: 'google_classroom' },
        payload: {
          messageId: 'message-1', registrationId: 'registration-1',
          collection: 'courses.courseWork.studentSubmissions',
          resourceId: { courseId: '123', courseWorkId: 'quiz-1', id: 'submission-1' },
          receivedAt: '2026-08-17T12:00:00.000Z',
        }, operation: operation(null),
      }, now: () => NOW + 1,
    });
    expect(notification).toEqual({
      connectionId: CONNECTION_ID, provider: 'google_classroom',
      sourceEventId: 'message-1', externalCourseId: '123', receivedAt: '2026-08-17T12:00:00.000Z',
    });
    await expect(invokeLearningProvider(adapter, {
      method: 'normalizeNotification', request: {
        subject: { connectionId: CONNECTION_ID, provider: 'google_classroom' },
        payload: {
          messageId: 'message-2', registrationId: 'registration-1', collection: 'courses.grades',
          resourceId: { courseId: '123' }, receivedAt: '2026-08-17T12:00:00.000Z',
        }, operation: operation(null),
      }, now: () => NOW + 1,
    })).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});

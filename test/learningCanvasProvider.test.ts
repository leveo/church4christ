import { describe, expect, it, vi } from 'vitest';
import {
  LearningProviderError,
  learningSyntheticEnrollmentId,
  type LearningConnectionUrlPolicy,
} from '../src/lib/learningModel';
import { invokeLearningProvider, type LearningOperationContext } from '../src/lib/learningProvider';
import {
  CANVAS_REQUIRED_SCOPES,
  createCanvasProvider,
  type CanvasProviderDependencies,
} from '../src/lib/learningCanvasProvider';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const CONNECTION_ID = 811;
const BASE_URL = 'https://canvas.church.example';
const POLICY: LearningConnectionUrlPolicy = Object.freeze({
  connectionId: CONNECTION_ID,
  provider: 'canvas',
  baseUrl: BASE_URL,
  providerLaunchOrigins: Object.freeze([BASE_URL]),
  providerFileOrigins: Object.freeze([BASE_URL]),
  externalLinkOrigins: Object.freeze(['https://resources.church.example']),
});

function operation(
  externalCourseId: string | null,
  externalActivityId: string | null = null,
  externalEnrollmentId: string | null = null,
): LearningOperationContext {
  return Object.freeze({
    scope: Object.freeze({
      connectionId: CONNECTION_ID,
      provider: 'canvas' as const,
      externalCourseId,
      externalActivityId,
      externalEnrollmentId,
    }),
    startedAt: '2026-08-17T12:00:00.000Z',
    deadlineAt: '2026-08-17T12:01:00.000Z',
    maxPages: 20,
    maxItems: 1_000,
    maxRawBytes: 10_485_760,
    maxNormalizedBytes: 10_485_760,
    maxUniqueKeyBytes: 1_048_576,
    signal: new AbortController().signal,
  });
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function provider(fetcher: CanvasProviderDependencies['fetcher']) {
  return createCanvasProvider({
    connectionId: CONNECTION_ID,
    baseUrl: BASE_URL,
    accessToken: 'private-canvas-token',
    urlPolicy: POLICY,
    fetcher,
    now: () => NOW + 1,
  });
}

describe('Canvas provider adapter', () => {
  it('declares only the documented read scopes used by the adapter', () => {
    expect(CANVAS_REQUIRED_SCOPES).toEqual([
      'url:GET|/api/v1/courses',
      'url:GET|/api/v1/courses/:course_id',
      'url:GET|/api/v1/courses/:course_id/users',
      'url:GET|/api/v1/courses/:course_id/modules',
      'url:GET|/api/v1/courses/:course_id/modules/:module_id/items/:id',
      'url:GET|/api/v1/courses/:course_id/pages/:url_or_id',
      'url:GET|/api/v1/files/:id',
      'url:GET|/api/v1/courses/:course_id/assignments',
      'url:GET|/api/v1/courses/:course_id/quizzes',
      'url:GET|/api/v1/courses/:course_id/assignments/:assignment_id/submissions',
    ]);
  });

  it('uses exact-origin bearer requests, manual redirects, and opaque Canvas Link pagination', async () => {
    const next = `${BASE_URL}/api/v1/courses?per_page=100&page=opaque%2B2`;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(BASE_URL);
      expect(url.pathname).toBe('/api/v1/courses');
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-canvas-token');
      expect(init?.redirect).toBe('manual');
      return json([{
        id: 42,
        name: 'Genesis 1',
        workflow_state: 'available',
        start_at: '2026-08-17T09:00:00.000Z',
      }], 200, { link: `<${next}>; rel="next", <${BASE_URL}/api/v1/courses?per_page=100&page=1>; rel="current"` });
    });
    const result = await invokeLearningProvider(provider(fetcher), {
      method: 'listCourses',
      request: {
        subject: { connectionId: CONNECTION_ID, provider: 'canvas' },
        page: { pageSize: 100, pageNumber: 1, pageToken: null },
        operation: operation(null),
      },
      urlPolicy: POLICY,
      now: () => NOW + 1,
    });
    expect(result.items).toEqual([{
      connectionId: CONNECTION_ID,
      provider: 'canvas',
      externalCourseId: '42',
      displayName: 'Genesis 1',
      launchUrl: `${BASE_URL}/courses/42`,
      lifecycleState: 'active',
      providerUpdatedAt: '2026-08-17T09:00:00.000Z',
      lastSyncedAt: null,
    }]);
    expect(result.nextPageToken).toBe(next);
    expect(JSON.stringify(result)).not.toMatch(/private-canvas-token|syllabus|email|grade/iu);
  });

  it('rejects cross-origin, credential-bearing, fragmented, and token-leaking Link next URLs', async () => {
    const badLinks = [
      'https://attacker.example/api/v1/courses?page=2',
      'https://user:password@canvas.church.example/api/v1/courses?page=2',
      `${BASE_URL}/api/v1/courses?page=2#fragment`,
      `${BASE_URL}/api/v1/courses?page=2&access_token=leak`,
    ];
    for (const next of badLinks) {
      await expect(invokeLearningProvider(provider(async () => json([], 200, {
        link: `<${next}>; rel="next"`,
      })), {
        method: 'listCourses',
        request: {
          subject: { connectionId: CONNECTION_ID, provider: 'canvas' },
          page: { pageSize: 100, pageNumber: 1, pageToken: null },
          operation: operation(null),
        },
        urlPolicy: POLICY,
        now: () => NOW + 1,
      })).rejects.toMatchObject({ code: 'malformed_response' });
    }
  });

  it('aggregates a unique Canvas user enrollment without profiles, emails, or grades', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v1/courses/42/users');
      expect(url.searchParams.getAll('include[]')).toEqual(['enrollments']);
      return json([{
        id: 99,
        enrollments: [
          { type: 'StudentEnrollment', enrollment_state: 'completed' },
          { type: 'TeacherEnrollment', enrollment_state: 'active' },
        ],
      }]);
    });
    const result = await invokeLearningProvider(provider(fetcher), {
      method: 'syncEnrollments',
      request: {
        subject: { connectionId: CONNECTION_ID, provider: 'canvas', externalCourseId: '42' },
        page: { pageSize: 100, pageNumber: 1, pageToken: null },
        operation: operation('42'),
      },
      now: () => NOW + 1,
    });
    expect(result.items).toEqual([{
      connectionId: CONNECTION_ID,
      provider: 'canvas',
      externalCourseId: '42',
      externalUserId: '99',
      externalEnrollmentId: learningSyntheticEnrollmentId({
        provider: 'canvas', externalCourseId: '42', externalUserId: '99',
      }),
      role: 'teacher',
      state: 'active',
    }]);
    expect(JSON.stringify(result)).not.toMatch(/name|email|grades|scores|avatar/iu);
  });

  it('paginates modules, assignments, then quizzes and retains metadata only', async () => {
    const paths: string[] = [];
    const adapter = provider(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith('/modules')) return json([{
        id: 7,
        name: 'Creation',
        workflow_state: 'active',
        items: [{ id: 8, title: 'Read Genesis 1', type: 'Page', html_url: `${BASE_URL}/courses/42/pages/genesis-1`, published: true }],
      }]);
      if (url.pathname.endsWith('/assignments')) return json([{
        id: 10,
        name: 'Reflection',
        html_url: `${BASE_URL}/courses/42/assignments/10`,
        due_at: '2026-08-19T12:00:00.000Z',
        published: true,
        updated_at: '2026-08-17T10:00:00.000Z',
      }]);
      return json([{
        id: 11,
        assignment_id: 12,
        title: 'Genesis 1 Quiz',
        html_url: `${BASE_URL}/courses/42/quizzes/11`,
        due_at: '2026-08-20T12:00:00.000Z',
        published: true,
        updated_at: '2026-08-17T11:00:00.000Z',
      }]);
    });
    const all = [];
    let pageToken: string | null = null;
    for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
      const page = await invokeLearningProvider(adapter, {
        method: 'syncActivities',
        request: {
          subject: { connectionId: CONNECTION_ID, provider: 'canvas', externalCourseId: '42' },
          page: { pageSize: 100, pageNumber, pageToken },
          operation: operation('42'),
        },
        urlPolicy: POLICY,
        now: () => NOW + 1,
      });
      all.push(...page.items);
      pageToken = page.nextPageToken;
    }
    expect(all.map((item) => [item.externalActivityId, item.kind])).toEqual([
      ['module:7:item:8', 'material'],
      ['assignment:10', 'assignment'],
      ['quiz:11:assignment:12', 'quiz'],
    ]);
    expect(paths).toEqual([
      '/api/v1/courses/42/modules',
      '/api/v1/courses/42/assignments',
      '/api/v1/courses/42/quizzes',
    ]);
    expect(JSON.stringify(all)).not.toMatch(/description|quiz_data|question|answer|grade|rubric/iu);
  });

  it('loads page/link/file module resources as launch metadata without content or file bytes', async () => {
    const resources = [
      {
        activityId: 'module:7:item:8',
        item: { id: 8, title: 'Genesis page', type: 'Page', page_url: 'genesis-1', html_url: `${BASE_URL}/courses/42/pages/genesis-1` },
        detail: { url: 'genesis-1', title: 'Genesis page', html_url: `${BASE_URL}/courses/42/pages/genesis-1`, updated_at: '2026-08-17T10:00:00.000Z' },
        kind: 'link',
      },
      {
        activityId: 'module:7:item:9',
        item: { id: 9, title: 'Worksheet', type: 'File', content_id: 55, html_url: `${BASE_URL}/courses/42/modules/items/9` },
        detail: { id: 55, display_name: 'Worksheet.pdf', 'content-type': 'application/pdf', size: 1234, updated_at: '2026-08-17T10:00:00.000Z', url: `${BASE_URL}/files/55/download` },
        kind: 'provider_file',
      },
      {
        activityId: 'module:7:item:10',
        item: { id: 10, title: 'Reading', type: 'ExternalUrl', external_url: 'https://resources.church.example/genesis', html_url: `${BASE_URL}/courses/42/modules/items/10` },
        detail: null,
        kind: 'link',
      },
    ] as const;
    for (const fixture of resources) {
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/items/${fixture.item.id}`)) return json(fixture.item);
        if (fixture.detail === null) throw new Error('unexpected detail fetch');
        return json(fixture.detail);
      });
      const result = await invokeLearningProvider(provider(fetcher), {
        method: 'syncResources',
        request: {
          subject: {
            connectionId: CONNECTION_ID,
            provider: 'canvas',
            externalCourseId: '42',
            externalActivityId: fixture.activityId,
          },
          page: { pageSize: 100, pageNumber: 1, pageToken: null },
          operation: operation('42', fixture.activityId),
        },
        urlPolicy: POLICY,
        now: () => NOW + 1,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.kind).toBe(fixture.kind);
      expect(JSON.stringify(result)).not.toMatch(/body|description|lock_info|file_bytes|verifier/iu);
    }
  });

  it('normalizes assignment-backed quiz submissions without grades, comments, answers, or attachments', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v1/courses/42/assignments/12/submissions');
      expect(url.searchParams.has('include[]')).toBe(false);
      return json([{
        user_id: 99,
        workflow_state: 'graded',
        late: true,
        attempt: 2,
        submitted_at: '2026-08-17T10:00:00.000Z',
        graded_at: '2026-08-17T11:00:00.000Z',
        updated_at: '2026-08-17T11:00:00.000Z',
      }]);
    });
    const result = await invokeLearningProvider(provider(fetcher), {
      method: 'syncSubmissions',
      request: {
        subject: {
          connectionId: CONNECTION_ID,
          provider: 'canvas',
          externalCourseId: '42',
          externalActivityId: 'quiz:11:assignment:12',
          externalEnrollmentId: null,
        },
        page: { pageSize: 100, pageNumber: 1, pageToken: null },
        operation: operation('42', 'quiz:11:assignment:12'),
      },
      now: () => NOW + 1,
    });
    expect(result.items[0]).toMatchObject({
      externalUserId: '99',
      status: 'returned',
      late: 1,
      attemptNumber: 2,
      submittedAt: '2026-08-17T10:00:00.000Z',
      returnedAt: '2026-08-17T11:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toMatch(/grade|score|comment|answer|attachment/iu);
  });

  it('classifies auth, throttle, retry-after, transient, oversized, timeout, and redirect failures safely', async () => {
    const cases = [
      [401, {}, 'authentication_required', null],
      [403, {}, 'permission_denied', null],
      [429, { 'retry-after': '45' }, 'rate_limited', 45],
      [503, {}, 'provider_unavailable', null],
      [302, { location: 'https://attacker.example/steal' }, 'provider_unavailable', null],
    ] as const;
    for (const [status, headers, code, retryAfterSeconds] of cases) {
      const error = await invokeLearningProvider(provider(async () => json({
        errors: [{ message: 'private upstream body' }],
      }, status, headers)), {
        method: 'listCourses',
        request: {
          subject: { connectionId: CONNECTION_ID, provider: 'canvas' },
          page: { pageSize: 100, pageNumber: 1, pageToken: null },
          operation: operation(null),
        },
        urlPolicy: POLICY,
        now: () => NOW + 1,
      }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(LearningProviderError);
      expect(error).toMatchObject({ code, provider: 'canvas', httpStatus: status, retryAfterSeconds });
      expect(String(error)).not.toMatch(/private|upstream|token/iu);
    }
    await expect(invokeLearningProvider(provider(async () => new Response(new Uint8Array(1_048_577), {
      headers: { 'content-length': '1048577' },
    })), {
      method: 'listCourses',
      request: {
        subject: { connectionId: CONNECTION_ID, provider: 'canvas' },
        page: { pageSize: 100, pageNumber: 1, pageToken: null },
        operation: operation(null),
      },
      urlPolicy: POLICY,
      now: () => NOW + 1,
    })).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('builds only exact Canvas launch URLs and normalizes bounded reconciler notifications', async () => {
    const adapter = provider(async () => { throw new Error('must not fetch'); });
    const launch = await invokeLearningProvider(adapter, {
      method: 'buildLaunchUrl',
      request: {
        subject: {
          connectionId: CONNECTION_ID,
          provider: 'canvas',
          externalCourseId: '42',
          externalActivityId: 'assignment:10',
        },
        operation: operation('42', 'assignment:10'),
      },
      urlPolicy: POLICY,
      now: () => NOW + 1,
    });
    expect(launch.url).toBe(`${BASE_URL}/courses/42/assignments/10`);
    const notification = await invokeLearningProvider(adapter, {
      method: 'normalizeNotification',
      request: {
        subject: { connectionId: CONNECTION_ID, provider: 'canvas' },
        payload: {
          sourceEventId: 'request-1:assignment_updated',
          externalCourseId: '42',
          receivedAt: '2026-08-17T12:00:00.000Z',
        },
        operation: operation(null),
      },
      now: () => NOW + 1,
    });
    expect(notification).toEqual({
      connectionId: CONNECTION_ID,
      provider: 'canvas',
      sourceEventId: 'request-1:assignment_updated',
      externalCourseId: '42',
      receivedAt: '2026-08-17T12:00:00.000Z',
    });
  });
});

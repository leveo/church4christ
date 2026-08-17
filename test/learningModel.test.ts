import { describe, expect, it } from 'vitest';
import {
  LEARNING_ACTIVITY_KINDS,
  LEARNING_ACTIVITY_LIFECYCLE_STATES,
  LEARNING_CONNECTION_STATUSES,
  LEARNING_COURSE_LIFECYCLE_STATES,
  LEARNING_ENROLLMENT_ROLES,
  LEARNING_ENROLLMENT_STATES,
  LEARNING_EVENT_TYPES,
  LEARNING_IDENTITY_STATUSES,
  LEARNING_PROVIDERS,
  LEARNING_RESOURCE_KINDS,
  LEARNING_SUBMISSION_STATES,
  LEARNING_SYNC_STATUSES,
  LEARNING_SYNC_TRIGGERS,
  LearningValidationError,
  learningActivityEventDeduplicationKey,
  learningActivitySubjectKey,
  learningActivityUniquenessKeys,
  learningCourseSubjectKey,
  learningCourseUniquenessKeys,
  learningEnrollmentSubjectKey,
  learningEnrollmentUniquenessKeys,
  learningIdentitySubjectKey,
  learningIdentityUniquenessKeys,
  learningProviderSubjectKey,
  learningResourceSubjectKey,
  learningResourceUniquenessKeys,
  learningSubmissionSubjectKey,
  learningSubmissionUniquenessKeys,
  normalizeCanvasBaseUrl,
  normalizeLearningActivity,
  normalizeLearningActivityEvent,
  normalizeLearningConnection,
  normalizeLearningConnectionUrlPolicy,
  normalizeLearningCourse,
  normalizeLearningDevelopmentEndpoint,
  normalizeLearningEnrollment,
  normalizeLearningIdentity,
  normalizeLearningLaunchContract,
  normalizeLearningLaunchUrl,
  normalizeLearningResource,
  normalizeLearningSubmissionSnapshot,
  normalizeYouTube,
} from '../src/lib/learningModel';

const URL_POLICY = {
  provider: 'canvas',
  connectionId: 7,
  baseUrl: 'https://canvas.church.test',
  providerLaunchOrigins: ['https://canvas.church.test'],
  providerFileOrigins: ['https://files.church.test'],
  externalLinkOrigins: ['https://links.example.test', 'https://drive.google.com'],
} as const;

const GOOGLE_URL_POLICY = {
  provider: 'google_classroom',
  connectionId: 8,
  baseUrl: null,
  providerLaunchOrigins: ['https://classroom.google.com'],
  providerFileOrigins: ['https://drive.google.com', 'https://files.googleusercontent.com'],
  externalLinkOrigins: ['https://links.example.test', 'https://drive.google.com'],
} as const;

function validConnection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    displayName: 'Church Canvas',
    baseUrl: 'https://canvas.church.test',
    status: 'active',
    revision: 2,
    lastSuccessfulSyncAt: '2026-08-16T10:30:00-05:00',
    lastErrorCode: null,
    ...overrides,
  };
}

function validCourse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId: 'course-42',
    displayName: 'Foundations',
    launchUrl: 'https://canvas.church.test/courses/42?module_item=7',
    lifecycleState: 'active',
    providerUpdatedAt: '2026-08-16T15:30:00Z',
    lastSyncedAt: null,
    ...overrides,
  };
}

function validIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    personId: 12,
    externalUserId: 'user-12',
    status: 'active',
    ...overrides,
  };
}

function validEnrollment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId: 'course-42',
    personId: 12,
    externalUserId: 'user-12',
    externalEnrollmentId: 'enrollment-9',
    role: 'student',
    state: 'active',
    lastSyncedAt: '2026-08-16T15:31:00Z',
    ...overrides,
  };
}

function validActivity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId: 'course-42',
    externalActivityId: 'activity-3',
    title: 'Reflection quiz',
    kind: 'quiz',
    lifecycleState: 'published',
    launchUrl: 'https://canvas.church.test/courses/42/quizzes/3?module_item=7',
    dueAt: '2026-08-20T23:59:00-05:00',
    publishedAt: '2026-08-15T12:00:00Z',
    providerUpdatedAt: '2026-08-16T15:32:00Z',
    lastSyncedAt: null,
    ...overrides,
  };
}

function validResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId: 'course-42',
    externalActivityId: 'activity-3',
    externalResourceId: 'resource-5',
    title: 'Study guide',
    kind: 'provider_file',
    launchUrl: 'https://files.church.test/files/5?download=1',
    youtubeVideoId: null,
    mimeType: 'application/pdf',
    sizeBytes: 2147483647,
    providerUpdatedAt: '2026-08-16T15:32:00Z',
    ...overrides,
  };
}

function validSubmission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId: 'course-42',
    externalActivityId: 'activity-3',
    activityKind: 'quiz',
    personId: 12,
    externalUserId: 'user-12',
    externalEnrollmentId: 'enrollment-9',
    status: 'submitted',
    late: 0,
    attemptNumber: 1,
    submittedAt: '2026-08-16T15:40:00Z',
    returnedAt: null,
    providerUpdatedAt: '2026-08-16T15:40:05Z',
    syncedAt: '2026-08-16T15:41:00Z',
    ...overrides,
  };
}

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'event-local-1',
    connectionId: 7,
    provider: 'canvas',
    sourceEventId: 'provider-event-1',
    eventType: 'quiz_submitted',
    personId: 12,
    identityLinkId: 21,
    enrollmentId: 31,
    courseId: 41,
    activityId: 51,
    activityKind: 'quiz',
    occurredAt: '2026-08-16T15:40:00Z',
    ingestedAt: '2026-08-16T15:41:00Z',
    ...overrides,
  };
}

const expectInvalid = (run: () => unknown): void => {
  expect(run).toThrow(LearningValidationError);
  expect(run).toThrow('Learning input is invalid');
};

describe('Learning model allowlists', () => {
  it('exports the exact enum values enforced by migration 0017', () => {
    expect(LEARNING_PROVIDERS).toEqual(['google_classroom', 'canvas']);
    expect(LEARNING_CONNECTION_STATUSES).toEqual(['pending', 'active', 'error', 'disabled']);
    expect(LEARNING_IDENTITY_STATUSES).toEqual(['active', 'disabled', 'conflict']);
    expect(LEARNING_COURSE_LIFECYCLE_STATES).toEqual(['active', 'archived', 'deleted']);
    expect(LEARNING_ENROLLMENT_ROLES).toEqual(['student', 'teacher', 'observer']);
    expect(LEARNING_ENROLLMENT_STATES).toEqual(['active', 'invited', 'completed', 'inactive']);
    expect(LEARNING_ACTIVITY_KINDS).toEqual(['material', 'assignment', 'quiz']);
    expect(LEARNING_ACTIVITY_LIFECYCLE_STATES).toEqual(['draft', 'published', 'archived', 'deleted']);
    expect(LEARNING_RESOURCE_KINDS).toEqual(['youtube', 'provider_file', 'link']);
    expect(LEARNING_SUBMISSION_STATES).toEqual(['not_submitted', 'submitted', 'returned', 'excused']);
    expect(LEARNING_EVENT_TYPES).toEqual([
      'enrolled', 'resource_opened', 'assignment_submitted', 'quiz_submitted',
      'submission_returned', 'course_completed',
    ]);
    expect(LEARNING_SYNC_TRIGGERS).toEqual(['manual', 'scheduled', 'notification']);
    expect(LEARNING_SYNC_STATUSES).toEqual(['running', 'succeeded', 'failed', 'cancelled']);
    for (const allowlist of [
      LEARNING_PROVIDERS,
      LEARNING_CONNECTION_STATUSES,
      LEARNING_IDENTITY_STATUSES,
      LEARNING_COURSE_LIFECYCLE_STATES,
      LEARNING_ENROLLMENT_ROLES,
      LEARNING_ENROLLMENT_STATES,
      LEARNING_ACTIVITY_KINDS,
      LEARNING_ACTIVITY_LIFECYCLE_STATES,
      LEARNING_RESOURCE_KINDS,
      LEARNING_SUBMISSION_STATES,
      LEARNING_EVENT_TYPES,
      LEARNING_SYNC_TRIGGERS,
      LEARNING_SYNC_STATUSES,
    ]) expect(Object.isFrozen(allowlist)).toBe(true);
  });

  it('rejects unknown values for every allowlist', () => {
    const cases: Array<() => unknown> = [
      () => normalizeLearningConnection(validConnection({ provider: 'moodle' }), URL_POLICY),
      () => normalizeLearningConnection(validConnection({ status: 'ready' }), URL_POLICY),
      () => normalizeLearningIdentity(validIdentity({ status: 'merged' })),
      () => normalizeLearningCourse(validCourse({ lifecycleState: 'hidden' }), URL_POLICY),
      () => normalizeLearningEnrollment(validEnrollment({ role: 'owner' })),
      () => normalizeLearningEnrollment(validEnrollment({ state: 'removed' })),
      () => normalizeLearningActivity(validActivity({ kind: 'discussion' }), URL_POLICY),
      () => normalizeLearningActivity(validActivity({ lifecycleState: 'hidden' }), URL_POLICY),
      () => normalizeLearningResource(validResource({ kind: 'blob' }), URL_POLICY),
      () => normalizeLearningSubmissionSnapshot(validSubmission({ status: 'graded' })),
      () => normalizeLearningActivityEvent(validEvent({ eventType: 'grade_changed' })),
    ];
    for (const run of cases) expectInvalid(run);
  });
});

describe('plain-object and safe-field policy', () => {
  it('accepts only data-only plain records with exact fields', () => {
    expectInvalid(() => normalizeLearningConnection(null, URL_POLICY));
    expectInvalid(() => normalizeLearningConnection([], URL_POLICY));
    expectInvalid(() => normalizeLearningConnection(new (class Connection {})(), URL_POLICY));
    expectInvalid(() => normalizeLearningConnection({ ...validConnection(), extra: true }, URL_POLICY));
    expectInvalid(() => normalizeLearningCourse({ ...validCourse(), content: 'private work' }, URL_POLICY));
    expectInvalid(() => normalizeLearningIdentity({ ...validIdentity(), email: 'person@example.test' }));
    expectInvalid(() => normalizeLearningEnrollment({ ...validEnrollment(), accessToken: 'secret-token' }));
    expectInvalid(() => normalizeLearningActivity({ ...validActivity(), description: 'provider body' }, URL_POLICY));
    expectInvalid(() => normalizeLearningResource({ ...validResource(), fileBytes: new Uint8Array([1]) }, URL_POLICY));
    expectInvalid(() => normalizeLearningSubmissionSnapshot({ ...validSubmission(), grade: 'A' }));
    expectInvalid(() => normalizeLearningSubmissionSnapshot({ ...validSubmission(), answer: 'private' }));
    expectInvalid(() => normalizeLearningActivityEvent({ ...validEvent(), payload: { token: 'secret' } }));
  });

  it('rejects accessor properties without evaluating them', () => {
    let evaluated = false;
    const input = validConnection();
    Object.defineProperty(input, 'displayName', {
      enumerable: true,
      get() {
        evaluated = true;
        return 'Unsafe';
      },
    });
    expectInvalid(() => normalizeLearningConnection(input, URL_POLICY));
    expect(evaluated).toBe(false);
  });

  it('translates hostile record reflection failures without leaking their messages', () => {
    const secret = 'proxy-provider-secret';
    const input = new Proxy(validConnection(), {
      getPrototypeOf() {
        throw new Error(secret);
      },
    });
    let caught: unknown;
    try {
      normalizeLearningConnection(input, URL_POLICY);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LearningValidationError);
    expect(String(caught)).not.toContain(secret);
  });
});

describe('connection, strings, numbers, and timestamps', () => {
  it('normalizes a bounded Canvas connection and freezes the result', () => {
    const normalized = normalizeLearningConnection(validConnection(), URL_POLICY);
    expect(normalized).toEqual({
      ...validConnection(),
      lastSuccessfulSyncAt: '2026-08-16T15:30:00.000Z',
    });
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('enforces provider/base URL coherence', () => {
    expect(normalizeLearningConnection(validConnection({
      connectionId: 8,
      provider: 'google_classroom',
      displayName: 'Google Classroom',
      baseUrl: null,
    }), GOOGLE_URL_POLICY).baseUrl).toBeNull();
    expectInvalid(() => normalizeLearningConnection(validConnection({ provider: 'google_classroom' }), URL_POLICY));
    expectInvalid(() => normalizeLearningConnection(validConnection({ baseUrl: null }), URL_POLICY));
  });

  it('uses UTF-8 bytes for database-aligned string boundaries', () => {
    expect(normalizeLearningConnection(validConnection({ displayName: '教'.repeat(40) }), URL_POLICY).displayName)
      .toBe('教'.repeat(40));
    expectInvalid(() => normalizeLearningConnection(validConnection({ displayName: '教'.repeat(41) }), URL_POLICY));
    expect(normalizeLearningCourse(validCourse({
      externalCourseId: '课'.repeat(85),
      displayName: `${'课'.repeat(66)}ab`,
    }), URL_POLICY).externalCourseId).toBe('课'.repeat(85));
    expectInvalid(() => normalizeLearningCourse(validCourse({ externalCourseId: `${'课'.repeat(85)}a` }), URL_POLICY));
    expectInvalid(() => normalizeLearningCourse(validCourse({ displayName: `${'课'.repeat(66)}abc` }), URL_POLICY));
    expect(normalizeLearningActivity(validActivity({ title: '课'.repeat(100) }), URL_POLICY).title)
      .toBe('课'.repeat(100));
    expectInvalid(() => normalizeLearningActivity(validActivity({ title: `${'课'.repeat(100)}a` }), URL_POLICY));
  });

  it('trims accepted display and id strings but rejects empty/control input', () => {
    expect(normalizeLearningCourse(validCourse({
      externalCourseId: '  external-id  ',
      displayName: '  Foundations  ',
    }), URL_POLICY)).toMatchObject({ externalCourseId: 'external-id', displayName: 'Foundations' });
    for (const value of ['', '   ', 'bad\0id', 'bad\nid', 'bad\tid', 'bad\u007fid']) {
      expectInvalid(() => normalizeLearningCourse(validCourse({ externalCourseId: value }), URL_POLICY));
    }
    expectInvalid(() => normalizeLearningCourse(validCourse({ externalCourseId: 'external-id\n' }), URL_POLICY));
  });

  it('enforces integral database bounds for ids, versions, booleans, attempts, and sizes', () => {
    for (const connectionId of [0, 1.5, 2147483648]) {
      expectInvalid(() => normalizeLearningConnection(validConnection({ connectionId }), URL_POLICY));
    }
    for (const revision of [-1, 1.5, 2147483648]) {
      expectInvalid(() => normalizeLearningConnection(validConnection({ revision }), URL_POLICY));
    }
    for (const late of [false, true, -1, 2]) {
      expectInvalid(() => normalizeLearningSubmissionSnapshot(validSubmission({ late })));
    }
    expect(normalizeLearningSubmissionSnapshot(validSubmission({ late: 1, attemptNumber: 1000 })).late).toBe(1);
    expectInvalid(() => normalizeLearningSubmissionSnapshot(validSubmission({ attemptNumber: 1001 })));
    expectInvalid(() => normalizeLearningResource(validResource({ sizeBytes: 2147483648 }), URL_POLICY));
  });

  it('canonicalizes real timestamps and rejects ambiguous or invalid timestamps', () => {
    expect(normalizeLearningActivity(validActivity(), URL_POLICY).dueAt).toBe('2026-08-21T04:59:00.000Z');
    for (const dueAt of ['2026-08-20', '2026-02-30T10:00:00Z', '08/20/2026 10:00', 'not-a-date', '2026-08-20T10:00:00']) {
      expectInvalid(() => normalizeLearningActivity(validActivity({ dueAt }), URL_POLICY));
    }
  });
});

describe('URL policy', () => {
  it('keeps provider launch, provider-file, external-link, and YouTube roles separate', () => {
    expectInvalid(() => normalizeLearningCourse(validCourse({
      launchUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    }), URL_POLICY));
    expectInvalid(() => normalizeLearningActivity(validActivity({
      launchUrl: 'https://files.church.test/activities/3',
    }), URL_POLICY));
    expectInvalid(() => normalizeLearningResource(validResource({
      launchUrl: 'https://links.example.test/files/5',
    }), URL_POLICY));
    expectInvalid(() => normalizeLearningResource(validResource({
      kind: 'link',
      launchUrl: 'https://files.church.test/files/5',
      youtubeVideoId: null,
      mimeType: null,
      sizeBytes: null,
    }), URL_POLICY));
    expect(normalizeLearningResource(validResource({
      kind: 'link',
      launchUrl: 'https://drive.google.com/open?id=external-study-guide',
      youtubeVideoId: null,
      mimeType: null,
      sizeBytes: null,
    }), URL_POLICY).launchUrl).toBe('https://drive.google.com/open?id=external-study-guide');
    expect(normalizeLearningResource(validResource({
      kind: 'youtube',
      launchUrl: 'https://youtu.be/dQw4w9WgXcQ?t=42',
      youtubeVideoId: 'dQw4w9WgXcQ',
      mimeType: null,
      sizeBytes: null,
    }), URL_POLICY).launchUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');

    expect(normalizeLearningCourse({
      ...validCourse(), provider: 'google_classroom', connectionId: 8,
      launchUrl: 'https://classroom.google.com/c/course-42',
    }, GOOGLE_URL_POLICY).launchUrl).toBe('https://classroom.google.com/c/course-42');
    expectInvalid(() => normalizeLearningCourse({
      ...validCourse(), provider: 'google_classroom', connectionId: 8,
      launchUrl: 'https://drive.google.com/drive/folders/course-42',
    }, GOOGLE_URL_POLICY));
  });

  it('requires a stable course and nullable activity subject in launch contracts', () => {
    const expectedCourse = {
      provider: 'canvas', connectionId: 7, externalCourseId: 'course-42', externalActivityId: null,
    } as const;
    expectInvalid(() => normalizeLearningLaunchContract({
      provider: 'canvas',
      connectionId: 7,
      externalActivityId: null,
      url: 'https://canvas.church.test/courses/42',
    }, URL_POLICY, expectedCourse));
    expectInvalid(() => normalizeLearningLaunchContract({
      ...expectedCourse,
      url: 'https://canvas.church.test/courses/42',
    }, URL_POLICY, { ...expectedCourse, externalCourseId: 'course-other' }));
    expectInvalid(() => normalizeLearningLaunchContract({
      provider: 'canvas', connectionId: 7, externalCourseId: 'course-42',
      url: 'https://canvas.church.test/courses/42',
    }, URL_POLICY, expectedCourse));
    const activity = normalizeLearningLaunchContract({
      ...expectedCourse,
      externalActivityId: 'activity-3',
      url: 'https://canvas.church.test/courses/42/activities/3',
    }, URL_POLICY, { ...expectedCourse, externalActivityId: 'activity-3' });
    expect(activity).toMatchObject({
      provider: 'canvas', connectionId: 7, externalCourseId: 'course-42', externalActivityId: 'activity-3',
    });
    expect(Object.isFrozen(activity)).toBe(true);
  });

  it('normalizes exact allowlisted HTTPS launch origins and retains bounded queries', () => {
    expect(normalizeLearningLaunchUrl(
      'https://canvas.church.test/courses/42/assignments/7?module_item=9&view=full',
      URL_POLICY,
      'provider_launch',
    )).toBe('https://canvas.church.test/courses/42/assignments/7?module_item=9&view=full');
  });

  it('rejects host confusion, userinfo, fragments, unexpected ports, and non-http schemes', () => {
    const invalid = [
      'https://canvas.church.test.evil.test/courses/42',
      'https://canvas.church.test@evil.test/courses/42',
      'https://user:pass@canvas.church.test/courses/42',
      'https://canvas.church.test/courses/42#access_token=secret',
      'https://canvas.church.test/courses/42#',
      'https://canvas.church.test:444/courses/42',
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///etc/passwd',
      'https:\\canvas.church.test\\courses\\42',
      'https://canvas.church.test/courses/%2f%2fevil.test',
      'https://canvas.church.test/courses/%2e%2e/admin',
      'https://canvas.church.test/courses/%0d%0aSet-Cookie:x',
      'https://canvas.church.test/courses/%zz',
    ];
    for (const url of invalid) expectInvalid(() => normalizeLearningLaunchUrl(url, URL_POLICY, 'provider_launch'));
  });

  it('keeps persisted URLs HTTPS-only and isolates local HTTP in a non-persisted contract', () => {
    const httpCanvasPolicy = {
      ...URL_POLICY,
      baseUrl: 'http://localhost:3000',
      providerLaunchOrigins: ['http://localhost:3000'],
      providerFileOrigins: ['http://localhost:3000'],
      externalLinkOrigins: ['http://localhost:3000'],
    } as const;
    expectInvalid(() => normalizeLearningConnection(validConnection({
      baseUrl: 'http://localhost:3000',
    }), httpCanvasPolicy));
    expectInvalid(() => normalizeLearningCourse(validCourse({
      launchUrl: 'http://localhost:3000/courses/1',
    }), httpCanvasPolicy));
    expectInvalid(() => normalizeLearningActivity(validActivity({
      launchUrl: 'http://localhost:3000/activities/1',
    }), httpCanvasPolicy));
    expectInvalid(() => normalizeLearningResource(validResource({
      launchUrl: 'http://localhost:3000/files/1',
    }), httpCanvasPolicy));

    const development = normalizeLearningDevelopmentEndpoint('http://localhost:3000/api/learning?q=ok');
    expect(development).toEqual({
      nonPersistedDevelopmentEndpoint: true,
      url: 'http://localhost:3000/api/learning?q=ok',
    });
    expect(Object.isFrozen(development)).toBe(true);
    expectInvalid(() => normalizeLearningDevelopmentEndpoint('http://canvas.church.test/api'));
  });

  it('accepts only a Canvas origin as a base URL and returns it without a slash', () => {
    expect(normalizeCanvasBaseUrl('https://canvas.church.test/', URL_POLICY))
      .toBe('https://canvas.church.test');
    for (const url of [
      'https://canvas.church.test/canvas',
      'https://canvas.church.test?tenant=church',
      'https://canvas.church.test?',
      'https://canvas.church.test/#fragment',
      'https://canvas.church.test:444',
      'https://canvas.church.test/.',
      'https://canvas.church.test/api/v1',
    ]) expectInvalid(() => normalizeCanvasBaseUrl(url, URL_POLICY));
  });

  it('binds immutable origin policies to one provider connection', () => {
    const canvas = normalizeLearningConnectionUrlPolicy(URL_POLICY);
    const google = normalizeLearningConnectionUrlPolicy(GOOGLE_URL_POLICY);
    expect(canvas).toEqual(URL_POLICY);
    expect(Object.isFrozen(canvas)).toBe(true);
    expect(Object.isFrozen(canvas.providerLaunchOrigins)).toBe(true);
    expect(Object.isFrozen(canvas.providerFileOrigins)).toBe(true);
    expect(Object.isFrozen(canvas.externalLinkOrigins)).toBe(true);

    expectInvalid(() => normalizeLearningCourse(validCourse(), google));
    expectInvalid(() => normalizeLearningCourse({
      ...validCourse(), provider: 'google_classroom', connectionId: 8,
      launchUrl: 'https://canvas.church.test/courses/42',
    }, GOOGLE_URL_POLICY));
    expectInvalid(() => normalizeLearningCourse({
      ...validCourse(), provider: 'google_classroom', connectionId: 7,
      launchUrl: 'https://classroom.google.com/c/42',
    }, GOOGLE_URL_POLICY));
    expectInvalid(() => normalizeLearningConnection(validConnection({
      baseUrl: 'https://other-canvas.test',
    }), URL_POLICY));
    expectInvalid(() => normalizeLearningConnectionUrlPolicy({
      ...URL_POLICY,
      providerLaunchOrigins: ['https://canvas.church.test', 'https://classroom.google.com'],
    }));
    expectInvalid(() => normalizeLearningConnectionUrlPolicy({
      ...URL_POLICY,
      externalLinkOrigins: ['https://www.youtube-nocookie.com'],
    }));
    expectInvalid(() => normalizeLearningConnectionUrlPolicy({
      ...URL_POLICY,
      baseUrl: 'https://canvas.church.test:444',
      providerLaunchOrigins: ['https://canvas.church.test:444'],
    }));

    const expectedCourse = {
      provider: 'canvas', connectionId: 7, externalCourseId: 'course-42', externalActivityId: null,
    } as const;
    const launch = normalizeLearningLaunchContract({
      ...expectedCourse,
      url: 'https://canvas.church.test/courses/42?module_item=7',
    }, canvas, expectedCourse);
    expect(launch).toEqual({
      ...expectedCourse,
      url: 'https://canvas.church.test/courses/42?module_item=7',
      origin: 'https://canvas.church.test',
    });
    expect(Object.isFrozen(launch)).toBe(true);
    expectInvalid(() => normalizeLearningLaunchContract({
      provider: 'google_classroom', connectionId: 8,
      externalCourseId: 'course-42', externalActivityId: null,
      url: 'https://classroom.google.com/c/42',
    }, canvas, {
      provider: 'google_classroom', connectionId: 8,
      externalCourseId: 'course-42', externalActivityId: null,
    }));
  });
});

describe('well-formed Unicode', () => {
  it('rejects every unpaired-surrogate shape before UTF-8 byte counting', () => {
    for (const [shape, displayName] of [
      ['isolated high', '\ud800'],
      ['isolated low', '\udc00'],
      ['reversed pair', '\udc00\ud800'],
      ['trailing high', `name\ud800`],
      ['leading low', `\udc00name`],
    ] as const) {
      expect(
        () => normalizeLearningConnection(validConnection({ displayName }), URL_POLICY),
        shape,
      ).toThrow(LearningValidationError);
    }
    expectInvalid(() => normalizeLearningCourse(validCourse({ externalCourseId: `id\ud800` }), URL_POLICY));
    expectInvalid(() => normalizeLearningLaunchUrl(
      'https://canvas.church.test/courses/\ud800', URL_POLICY, 'provider_launch',
    ));
  });

  it('accepts valid surrogate pairs and counts their four UTF-8 bytes at boundaries', () => {
    expect(normalizeLearningConnection(validConnection({ displayName: '😀'.repeat(30) }), URL_POLICY).displayName)
      .toBe('😀'.repeat(30));
    expectInvalid(() => normalizeLearningConnection(validConnection({
      displayName: `${'😀'.repeat(30)}a`,
    }), URL_POLICY));
  });
});

describe('YouTube normalization', () => {
  it('accepts strict ids and supported URL shapes and emits a privacy-enhanced embed', () => {
    for (const input of [
      'dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/embed/dQw4w9WgXcQ?rel=0',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://youtube.com/live/dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?t=42',
    ]) {
      expect(normalizeYouTube(input)).toEqual({
        videoId: 'dQw4w9WgXcQ',
        embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      });
    }
  });

  it('accepts only the exact canonical privacy-enhanced embed shape', () => {
    const canonical = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';
    expect(normalizeYouTube(canonical)).toEqual({
      videoId: 'dQw4w9WgXcQ',
      embedUrl: canonical,
    });

    for (const value of [
      'https://youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com.evil.test/embed/dQw4w9WgXcQ',
      'http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://user:pass@www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com:443/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com:444/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ#fragment',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
      'https://www.youtube-nocookie.com/embed',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ/extra',
      'https://www.youtube-nocookie.com/embed/%64Qw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed%2FdQw4w9WgXcQ',
      ' https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ ',
    ]) expectInvalid(() => normalizeYouTube(value));
  });

  it('rejects spoofing, playlists-only, credentials, fragments, and ambiguous ids', () => {
    const invalid = [
      'short',
      'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
      'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
      'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/playlist?list=PL123',
      'https://youtube.com/watch?v=dQw4w9WgXcQ&v=M7lc1UVf-VE',
      'https://youtube.com/embed/dQw4w9WgXcQ?v=M7lc1UVf-VE',
      'https://youtu.be/dQw4w9WgXcQ/extra',
      'https://youtu.be//dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ/',
      'https://youtu.be/dQw4w9WgXcQ#t=42',
      'http://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com:444/watch?v=dQw4w9WgXcQ',
    ];
    for (const value of invalid) expectInvalid(() => normalizeYouTube(value));
  });
});

describe('provider-neutral normalized records', () => {
  it('normalizes identity, enrollment, activity, resource, and submission shapes immutably', () => {
    const values = [
      normalizeLearningIdentity(validIdentity()),
      normalizeLearningEnrollment(validEnrollment()),
      normalizeLearningActivity(validActivity(), URL_POLICY),
      normalizeLearningResource(validResource(), URL_POLICY),
      normalizeLearningSubmissionSnapshot(validSubmission()),
    ];
    for (const value of values) expect(Object.isFrozen(value)).toBe(true);
    expect(values[1]).toMatchObject({ externalCourseId: 'course-42', externalUserId: 'user-12' });
    expect(values[4]).toMatchObject({ activityKind: 'quiz', late: 0, attemptNumber: 1 });
  });

  it('enforces resource-kind field coherence and YouTube id/url agreement', () => {
    expect(normalizeLearningResource(validResource({
      kind: 'youtube',
      launchUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      youtubeVideoId: 'dQw4w9WgXcQ',
      mimeType: null,
      sizeBytes: null,
    }), URL_POLICY).youtubeVideoId).toBe('dQw4w9WgXcQ');
    expectInvalid(() => normalizeLearningResource(validResource({ kind: 'link' }), URL_POLICY));
    expectInvalid(() => normalizeLearningResource(validResource({
      kind: 'youtube',
      launchUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      youtubeVideoId: 'M7lc1UVf-VE',
      mimeType: null,
      sizeBytes: null,
    }), URL_POLICY));
    expectInvalid(() => normalizeLearningResource(validResource({
      kind: 'youtube',
      launchUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      youtubeVideoId: 'M7lc1UVf-VE',
      mimeType: null,
      sizeBytes: null,
    }), URL_POLICY));
  });

  it('normalizes its own frozen canonical YouTube resource output idempotently', () => {
    const first = normalizeLearningResource(validResource({
      kind: 'youtube',
      launchUrl: 'https://youtu.be/dQw4w9WgXcQ?t=42',
      youtubeVideoId: 'dQw4w9WgXcQ',
      mimeType: null,
      sizeBytes: null,
    }), URL_POLICY);
    const second = normalizeLearningResource(first, URL_POLICY);

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(second).toEqual(first);
  });

  it('enforces submission activity-kind and timestamp coherence', () => {
    expectInvalid(() => normalizeLearningSubmissionSnapshot(validSubmission({ activityKind: 'material' })));
    expectInvalid(() => normalizeLearningSubmissionSnapshot(validSubmission({ status: 'not_submitted', submittedAt: '2026-08-16T15:40:00Z' })));
    expectInvalid(() => normalizeLearningSubmissionSnapshot(validSubmission({ status: 'submitted', submittedAt: null })));
    expectInvalid(() => normalizeLearningSubmissionSnapshot(validSubmission({ status: 'returned', returnedAt: null })));
  });

  it('enforces event reference/type coherence from migration 0017', () => {
    expect(normalizeLearningActivityEvent(validEvent()).activityKind).toBe('quiz');
    expect(normalizeLearningActivityEvent(validEvent({
      eventType: 'enrolled', activityId: null, activityKind: null,
    }))).toMatchObject({ eventType: 'enrolled', activityId: null, activityKind: null });
    expectInvalid(() => normalizeLearningActivityEvent(validEvent({ eventType: 'enrolled' })));
    expectInvalid(() => normalizeLearningActivityEvent(validEvent({ eventType: 'assignment_submitted', activityKind: 'quiz' })));
    expectInvalid(() => normalizeLearningActivityEvent(validEvent({ eventType: 'resource_opened', activityId: null, activityKind: null })));
  });

  it('builds collision-safe deterministic provider-scoped subject keys', () => {
    const providerA = learningProviderSubjectKey({ connectionId: 7, provider: 'canvas' });
    const providerB = learningProviderSubjectKey({ connectionId: 8, provider: 'canvas' });
    expect(providerA).not.toBe(providerB);
    expect(learningCourseSubjectKey(normalizeLearningCourse(validCourse(), URL_POLICY)))
      .toBe('["canvas",7,"course-42"]');
    expect(learningIdentitySubjectKey(normalizeLearningIdentity(validIdentity())))
      .toBe('["canvas",7,"user-12"]');
    expect(learningActivitySubjectKey(normalizeLearningActivity(validActivity(), URL_POLICY)))
      .toBe('["canvas",7,"course-42","activity-3"]');
    expect(learningEnrollmentSubjectKey(normalizeLearningEnrollment(validEnrollment())))
      .toBe('["canvas",7,"course-42","enrollment-9"]');
    expect(learningResourceSubjectKey(normalizeLearningResource(validResource(), URL_POLICY)))
      .toBe('["canvas",7,"course-42","activity-3","resource-5"]');
    expect(learningSubmissionSubjectKey(normalizeLearningSubmissionSnapshot(validSubmission())))
      .toBe('["canvas",7,"course-42","activity-3","enrollment-9"]');
    expect(learningActivityEventDeduplicationKey(normalizeLearningActivityEvent(validEvent())))
      .toBe('["canvas",7,"provider-event-1"]');
    expect(learningCourseSubjectKey(normalizeLearningCourse(validCourse({ externalCourseId: 'a:b' }), URL_POLICY)))
      .not.toBe(learningCourseSubjectKey(normalizeLearningCourse(validCourse({ externalCourseId: 'a' }), URL_POLICY)));
  });

  it('exports deterministic migration uniqueness keys for every synchronized entity', () => {
    const course = normalizeLearningCourse(validCourse(), URL_POLICY);
    const identity = normalizeLearningIdentity(validIdentity());
    const enrollment = normalizeLearningEnrollment(validEnrollment());
    const activity = normalizeLearningActivity(validActivity(), URL_POLICY);
    const resource = normalizeLearningResource(validResource(), URL_POLICY);
    const submission = normalizeLearningSubmissionSnapshot(validSubmission());

    expect(learningCourseUniquenessKeys(course)).toEqual([learningCourseSubjectKey(course)]);
    expect(learningActivityUniquenessKeys(activity)).toEqual([learningActivitySubjectKey(activity)]);
    expect(learningResourceUniquenessKeys(resource)).toEqual([learningResourceSubjectKey(resource)]);
    expect(learningSubmissionUniquenessKeys(submission)).toEqual([learningSubmissionSubjectKey(submission)]);
    expect(learningIdentityUniquenessKeys(identity)).toEqual([
      '["canvas",7,"external_user","user-12"]',
      '["canvas",7,"person",12]',
    ]);
    expect(learningEnrollmentUniquenessKeys(enrollment)).toEqual([
      '["canvas",7,"course-42","external_enrollment","enrollment-9"]',
      '["canvas",7,"course-42","identity_link_external_user","user-12"]',
      '["canvas",7,"course-42","identity_link_person",12]',
    ]);
    for (const keys of [
      learningCourseUniquenessKeys(course),
      learningIdentityUniquenessKeys(identity),
      learningEnrollmentUniquenessKeys(enrollment),
      learningActivityUniquenessKeys(activity),
      learningResourceUniquenessKeys(resource),
      learningSubmissionUniquenessKeys(submission),
    ]) expect(Object.isFrozen(keys)).toBe(true);
  });
});

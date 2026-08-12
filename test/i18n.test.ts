import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';
import { t } from '../src/lib/i18n';
import {
  ATTENDANCE_FORM_ERROR_CODES,
  type AttendanceFormErrorCode,
} from '../src/lib/serviceAttendanceForms';
import { PEOPLE_IMPORT_HEADERS, type PeopleImportIssueCode } from '../src/lib/peopleImport';
import type { PeopleImportDbIssueCode } from '../src/lib/peopleImportDb';
import {
  PEOPLE_IMPORT_HTTP_RESULT_CODES,
  type PeopleImportHttpResultCode,
} from '../src/lib/peopleImportContract';
import { PEOPLE_IMPORT_MAPPING_HTTP_RESULT_CODES } from '../src/lib/peopleImportMappingContract';
import {
  EVERY_PEOPLE_IMPORT_MAPPING_UI_ISSUE_CODE_IS_LISTED,
  PEOPLE_IMPORT_MAPPING_UI_ENUM_FIELDS,
  PEOPLE_IMPORT_MAPPING_UI_ENUM_VALUES,
  PEOPLE_IMPORT_MAPPING_UI_FIELDS,
  PEOPLE_IMPORT_MAPPING_UI_ISSUE_CODES,
} from '../src/lib/peopleImportMappingUi';

const dicts = { en, zh } as const;

const PEOPLE_IMPORT_ISSUE_CODES = [
  'file_too_large',
  'invalid_utf8',
  'nul_byte',
  'unclosed_quote',
  'illegal_quote',
  'lone_cr',
  'too_many_rows',
  'too_many_columns',
  'cell_too_long',
  'empty_file',
  'missing_header',
  'duplicate_header',
  'unknown_header',
  'required',
  'too_long',
  'invalid_email',
  'invalid_option',
  'invalid_date',
  'future_date',
  'forbidden_field',
  'household_fields_without_key',
  'duplicate_email',
  'household_requires_person',
  'household_name_required',
  'household_primary_required',
  'household_primary_multiple',
  'household_primary_must_be_adult',
  'household_metadata_conflict',
  'duplicate_dependent',
  'duplicate_household_name',
  'too_many_households',
  'issues_truncated',
] as const satisfies readonly PeopleImportIssueCode[];

const PEOPLE_IMPORT_DB_ISSUE_CODES = [
  'email_exists',
  'household_name_exists',
  'issues_truncated',
] as const satisfies readonly PeopleImportDbIssueCode[];

const PEOPLE_IMPORT_COPY_KEYS = [
  'admin.peopleImport.title',
  'admin.peopleImport.intro',
  'admin.peopleImport.limits',
  'admin.peopleImport.privacy',
  'admin.peopleImport.createOnly',
  'admin.peopleImport.d1Notice',
  'admin.peopleImport.template',
  'admin.peopleImport.templateHint',
  'admin.peopleImport.fileLabel',
  'admin.peopleImport.fileHint',
  'admin.peopleImport.preview',
  'admin.peopleImport.previewPending',
  'admin.peopleImport.previewRows',
  'admin.peopleImport.summary.title',
  'admin.peopleImport.summary.dataRows',
  'admin.peopleImport.summary.people',
  'admin.peopleImport.summary.dependents',
  'admin.peopleImport.summary.households',
  'admin.peopleImport.summary.inactivePeople',
  'admin.peopleImport.issues.title',
  'admin.peopleImport.issues.severity',
  'admin.peopleImport.issues.row',
  'admin.peopleImport.issues.field',
  'admin.peopleImport.issues.error',
  'admin.peopleImport.issues.warning',
  'admin.peopleImport.issues.file',
  'admin.peopleImport.warningAck',
  'admin.peopleImport.warningAckRequired',
  'admin.peopleImport.commit',
  'admin.peopleImport.commitPending',
  'admin.peopleImport.success.title',
  'admin.peopleImport.success.body',
  'admin.peopleImport.success.back',
  'admin.peopleImport.retry',
  'admin.peopleImport.repreviewRequired',
  'admin.peopleImport.genericError',
  'admin.peopleImport.networkError',
  'admin.peopleImport.previewError',
] as const;

const PEOPLE_IMPORT_RESULT_CODES = [
  'multipart_required',
  'multipart_invalid',
  'missing_file',
  'file_too_large',
  'file_type_invalid',
  'validation_failed',
  'warnings_not_acknowledged',
  'import_conflict',
  'import_failed',
  'generic_error',
  'forbidden',
  'not_found',
  'method_not_allowed',
] as const satisfies readonly PeopleImportHttpResultCode[];

type MissingPeopleImportIssueCode = Exclude<PeopleImportIssueCode, (typeof PEOPLE_IMPORT_ISSUE_CODES)[number]>;
type MissingPeopleImportDbIssueCode = Exclude<PeopleImportDbIssueCode, (typeof PEOPLE_IMPORT_DB_ISSUE_CODES)[number]>;
type MissingPeopleImportResultCode = Exclude<PeopleImportHttpResultCode, (typeof PEOPLE_IMPORT_RESULT_CODES)[number]>;
const everyPeopleImportIssueCodeIsListed: MissingPeopleImportIssueCode extends never ? true : never = true;
const everyPeopleImportDbIssueCodeIsListed: MissingPeopleImportDbIssueCode extends never ? true : never = true;
const everyPeopleImportResultCodeIsListed: MissingPeopleImportResultCode extends never ? true : never = true;

const PEOPLE_IMPORT_MAPPING_COPY_KEYS = [
  'admin.peopleImportMapping.entry',
  'admin.peopleImportMapping.title',
  'admin.peopleImportMapping.intro',
  'admin.peopleImportMapping.canonicalLink',
  'admin.peopleImportMapping.safetyTitle',
  'admin.peopleImportMapping.privacy',
  'admin.peopleImportMapping.createOnly',
  'admin.peopleImportMapping.profileImmutable',
  'admin.peopleImportMapping.modeBoundary',
  'admin.peopleImportMapping.d1Notice',
  'admin.peopleImportMapping.fileTitle',
  'admin.peopleImportMapping.sameFile',
  'admin.peopleImportMapping.dataRows',
  'admin.peopleImportMapping.headers',
  'admin.peopleImportMapping.inspectInvalid',
  'admin.peopleImportMapping.profileTitle',
  'admin.peopleImportMapping.profileSelect',
  'admin.peopleImportMapping.profileChoose',
  'admin.peopleImportMapping.profileNew',
  'admin.peopleImportMapping.profileRefresh',
  'admin.peopleImportMapping.profileClone',
  'admin.peopleImportMapping.profileCloneSuffix',
  'admin.peopleImportMapping.profileName',
  'admin.peopleImportMapping.profileSave',
  'admin.peopleImportMapping.profileSaveHint',
  'admin.peopleImportMapping.draftTitle',
  'admin.peopleImportMapping.draftHint',
  'admin.peopleImportMapping.canonicalField',
  'admin.peopleImportMapping.mode',
  'admin.peopleImportMapping.sourceOrConstant',
  'admin.peopleImportMapping.mode.empty',
  'admin.peopleImportMapping.mode.source',
  'admin.peopleImportMapping.mode.constant',
  'admin.peopleImportMapping.mode.emptyHint',
  'admin.peopleImportMapping.translationTitle',
  'admin.peopleImportMapping.translationHint',
  'admin.peopleImportMapping.translationAdd',
  'admin.peopleImportMapping.translationSource',
  'admin.peopleImportMapping.translationRemove',
  'admin.peopleImportMapping.previewTitle',
  'admin.peopleImportMapping.previewHint',
  'admin.peopleImportMapping.warningAck',
  'admin.peopleImportMapping.checkPeople',
  'admin.peopleImportMapping.chooseValidFile',
  'admin.peopleImportMapping.failure.network',
  'admin.peopleImportMapping.failure.unexpected',
  'admin.peopleImportMapping.failure.uncertainCreate',
  'admin.peopleImportMapping.failure.uncertainCommit',
  'admin.peopleImportMapping.failure.headerDrift',
] as const;

describe('dictionaries (parity, ported from the reference stack)', () => {
  it('has a non-empty string for every key in both locales', () => {
    for (const locale of ['en', 'zh'] as const) {
      for (const [key, value] of Object.entries(dicts[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('en and zh cover the identical key set', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it('uses the same {placeholders} in en and zh for every key', () => {
    const holders = (s: string) => (s.match(/\{[a-zA-Z_]+\}/g) ?? []).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(holders(zh[key]), `placeholders mismatch for ${key}`).toEqual(holders(en[key]));
    }
  });

  it('carries the required seed identity strings', () => {
    expect(en['site.name']).toBe('Church4Christ');
    expect(en['site.tagline']).toBe('A church for the city');
    expect(zh['site.name']).toBe('四方基督教会');
    expect(zh['site.tagline']).toBe('城市中的教会');
  });

  it('provides the aggregate Attendance grant label in both locales', () => {
    expect(en['admin.nav.attendance']).toBe('Service attendance');
    expect(zh['admin.nav.attendance']).toBe('崇拜出席');
  });

  it('provides complete bilingual aggregate Attendance UI copy', () => {
    const keys = [
      'admin.attendance.title', 'admin.attendance.intro', 'admin.attendance.recordTitle',
      'admin.attendance.service', 'admin.attendance.date', 'admin.attendance.adults',
      'admin.attendance.children', 'admin.attendance.total', 'admin.attendance.save',
      'admin.attendance.correct', 'admin.attendance.reportTitle', 'admin.attendance.from',
      'admin.attendance.to', 'admin.attendance.applyWindow', 'admin.attendance.downloadCsv',
      'admin.attendance.emptyReport', 'admin.attendance.emptyServices',
      'admin.attendance.emptyServicesAsk', 'admin.attendance.manageServiceTypes',
      'admin.attendance.linksTitle', 'admin.attendance.linksIntro',
      'admin.attendance.childrenOff', 'admin.attendance.linksSave', 'admin.attendance.linksLoadError',
      'admin.attendance.savedCount', 'admin.attendance.savedLinks',
      'admin.attendance.notConfigured', 'admin.attendance.error',
      'admin.dashboard.attendance',
    ] as const;
    for (const locale of ['en', 'zh'] as const) {
      for (const key of keys) expect(dicts[locale][key], `${locale}:${key}`).toBeTruthy();
    }
    expect(en['admin.attendance.emptyServicesAsk']).toMatch(/super admin|Volunteer ministry/i);
    expect(zh['admin.attendance.emptyServicesAsk']).toMatch(/超级管理员|义工事工/);
    expect(en['admin.attendance.childrenOff']).toMatch(/historical.*remain/i);
    expect(zh['admin.attendance.childrenOff']).toMatch(/历史.*保留/);
  });

  it('provides safe bilingual copy for every stable attendance form error code', () => {
    const keys = ATTENDANCE_FORM_ERROR_CODES.map(
      (code): `admin.attendance.error.${AttendanceFormErrorCode}` => `admin.attendance.error.${code}`,
    );
    expect(keys).toHaveLength(7);
    expect(new Set(keys).size).toBe(7);
    for (const locale of ['en', 'zh'] as const) {
      for (const key of keys) expect(dicts[locale][key], `${locale}:${key}`).toBeTruthy();
    }
  });

  it('provides complete bilingual Stripe test-mode operations copy', () => {
    const keys = [
      'admin.stripe.title', 'admin.stripe.testMode', 'admin.stripe.events', 'admin.stripe.requests',
      'admin.stripe.filter', 'admin.stripe.status', 'admin.stripe.actions', 'admin.stripe.replay',
      'admin.stripe.dismiss', 'admin.stripe.reconcile', 'admin.stripe.attach', 'admin.stripe.cancel',
      'admin.stripe.confirmDismiss', 'admin.stripe.confirmCancel', 'admin.stripe.replayWarning',
      'admin.stripe.replayExpired', 'admin.stripe.rawHidden', 'admin.stripe.emptyEvents',
      'admin.stripe.emptyRequests', 'admin.stripe.resultSuccess', 'admin.stripe.resultError',
      'admin.stripe.status.pending', 'admin.stripe.status.processing', 'admin.stripe.status.processed',
      'admin.stripe.status.ignored', 'admin.stripe.status.failed', 'admin.stripe.status.dismissed',
      'admin.stripe.request.creating', 'admin.stripe.request.attached', 'admin.stripe.request.manual_review',
      'admin.stripe.allStatuses', 'admin.stripe.allRequestStates', 'admin.stripe.previous', 'admin.stripe.next',
      'admin.stripe.eventId', 'admin.stripe.eventType', 'admin.stripe.attempts', 'admin.stripe.updatedAt',
      'admin.stripe.outcome', 'admin.stripe.lastError', 'admin.stripe.requestId',
      'admin.stripe.registrationId', 'admin.stripe.sessionId', 'admin.stripe.confirmation',
      'admin.stripe.replayHelp',
      'admin.stripe.completedAt',
      'admin.stripe.ageDays',
    ] as const;
    for (const key of keys) {
      expect(en[key], `en:${key}`).toBeTruthy();
      expect(zh[key], `zh:${key}`).toBeTruthy();
    }
    expect(en['admin.stripe.testMode']).toContain('Stripe test mode');
    expect(zh['admin.stripe.testMode']).toContain('Stripe 测试模式');
    expect(`${en['admin.stripe.testMode']} ${zh['admin.stripe.testMode']}`).not.toMatch(/enable live|启用正式/i);
    expect(en['admin.people.finance']).toContain('Giving and paid Registration');
    expect(zh['admin.people.finance']).toContain('奉献和付费报名');
  });

  it('provides every required People import UI, result, field, and issue key in both locales', () => {
    expect(everyPeopleImportIssueCodeIsListed).toBe(true);
    expect(everyPeopleImportDbIssueCodeIsListed).toBe(true);
    expect(everyPeopleImportResultCodeIsListed).toBe(true);
    expect(PEOPLE_IMPORT_HTTP_RESULT_CODES).toEqual(PEOPLE_IMPORT_RESULT_CODES);

    const required = [
      ...PEOPLE_IMPORT_COPY_KEYS,
      ...PEOPLE_IMPORT_HEADERS.map((field) => `admin.peopleImport.field.${field}`),
      ...PEOPLE_IMPORT_ISSUE_CODES.map((code) => `admin.peopleImport.issue.${code}`),
      ...PEOPLE_IMPORT_DB_ISSUE_CODES.map((code) => `admin.peopleImport.issue.${code}`),
      ...PEOPLE_IMPORT_RESULT_CODES.map((code) => `admin.peopleImport.result.${code}`),
    ];

    expect(PEOPLE_IMPORT_HEADERS).toHaveLength(18);
    for (const locale of ['en', 'zh'] as const) {
      for (const key of required) {
        expect(dicts[locale][key as keyof (typeof dicts)[typeof locale]], `${locale}:${key}`).toBeTruthy();
      }
    }
  });

  it('provides exhaustive bilingual source-mapping workflow copy', () => {
    const required = [
      ...PEOPLE_IMPORT_MAPPING_COPY_KEYS,
      ...PEOPLE_IMPORT_MAPPING_UI_FIELDS.map((field) => `admin.peopleImport.field.${field}`),
      ...PEOPLE_IMPORT_MAPPING_UI_ISSUE_CODES.map((code) => `admin.peopleImportMapping.issue.${code}`),
      ...PEOPLE_IMPORT_MAPPING_HTTP_RESULT_CODES.map((code) => `admin.peopleImportMapping.result.${code}`),
      ...PEOPLE_IMPORT_MAPPING_UI_ENUM_FIELDS.flatMap((field) => (
        PEOPLE_IMPORT_MAPPING_UI_ENUM_VALUES[field].map((value) => `admin.peopleImportMapping.enum.${field}.${value}`)
      )),
    ];

    expect(PEOPLE_IMPORT_MAPPING_UI_FIELDS).toHaveLength(18);
    expect(PEOPLE_IMPORT_MAPPING_UI_ENUM_FIELDS).toHaveLength(6);
    expect(EVERY_PEOPLE_IMPORT_MAPPING_UI_ISSUE_CODE_IS_LISTED).toBe(true);
    expect(PEOPLE_IMPORT_MAPPING_UI_ISSUE_CODES).toHaveLength(17);
    expect(PEOPLE_IMPORT_MAPPING_HTTP_RESULT_CODES).toHaveLength(23);
    for (const locale of ['en', 'zh'] as const) {
      for (const key of required) {
        expect(dicts[locale][key as keyof (typeof dicts)[typeof locale]], `${locale}:${key}`).toBeTruthy();
      }
    }
  });

  it('states source-mapping privacy, immutable/create-only boundaries, and D1 atomicity', () => {
    expect(en['admin.peopleImportMapping.privacy']).toMatch(/not retained|not saved/i);
    expect(en['admin.peopleImportMapping.createOnly']).toMatch(/create only/i);
    expect(en['admin.peopleImportMapping.profileImmutable']).toMatch(/immutable|cannot be edited/i);
    expect(en['admin.peopleImportMapping.modeBoundary']).toMatch(/six|6/);
    expect(en['admin.peopleImportMapping.d1Notice']).toMatch(/\b50\b/);
    expect(en['admin.peopleImportMapping.d1Notice']).toMatch(/\b500\b/);
    expect(en['admin.peopleImportMapping.d1Notice']).toMatch(/atomic/i);
    expect(zh['admin.peopleImportMapping.privacy']).toMatch(/不会保留|不会保存/);
    expect(zh['admin.peopleImportMapping.createOnly']).toContain('仅创建');
    expect(zh['admin.peopleImportMapping.profileImmutable']).toMatch(/不可变|不能编辑/);
    expect(zh['admin.peopleImportMapping.modeBoundary']).toContain('6');
    expect(zh['admin.peopleImportMapping.d1Notice']).toContain('50');
    expect(zh['admin.peopleImportMapping.d1Notice']).toContain('500');
    expect(zh['admin.peopleImportMapping.d1Notice']).toContain('原子');
    expect(zh['admin.peopleImportMapping.issue.header_drift']).toContain('顺序');
    expect(zh['admin.peopleImportMapping.issue.header_drift']).not.toContain('排序后的');
  });

  it('provides complete portable-export and sensitive-notes copy in both locales', () => {
    const required = [
      'admin.peopleExport.standardTitle',
      'admin.peopleExport.standardBody',
      'admin.peopleExport.standardDownload',
      'admin.peopleExport.discoverySummary',
      'admin.peopleExport.discoveryParts',
      'admin.peopleExport.discoveryRows',
      'admin.peopleExport.discoveryHouseholds',
      'admin.peopleExport.discoveryPart',
      'admin.peopleExport.discoveryDownload',
      'admin.peopleExport.discoveryRepairTitle',
      'admin.peopleExport.discoveryRepairBody',
      'admin.peopleExport.discoveryIssues',
      'admin.peopleExport.discoveryErrorTitle',
      'admin.peopleExport.discoveryErrorBody',
      'admin.peopleExport.notesTitle',
      'admin.peopleExport.notesBody',
      'admin.peopleExport.notesWarning',
      'admin.peopleExport.notesAudit',
      'admin.peopleExport.notesAcknowledge',
      'admin.peopleExport.notesDownload',
      'admin.peopleExport.back',
    ] as const;
    for (const locale of ['en', 'zh'] as const) {
      for (const key of required) expect(dicts[locale][key], `${locale}:${key}`).toBeTruthy();
    }
    expect(en['admin.peopleExport.standardBody']).toMatch(/pastoral notes/i);
    expect(en['admin.peopleExport.standardBody']).toMatch(/roles|permissions|security/i);
    expect(en['admin.peopleExport.standardBody']).toMatch(/multiple.*part/i);
    expect(zh['admin.peopleExport.standardBody']).toContain('牧养记录');
    expect(zh['admin.peopleExport.standardBody']).toMatch(/角色|权限|安全/);
    expect(zh['admin.peopleExport.standardBody']).toMatch(/多个.*分卷|多.*文件/);

    expect(en['admin.peopleExport.notesBody']).toMatch(/sensitive/i);
    expect(en['admin.peopleExport.notesBody']).toMatch(/note (?:text|body)|pastoral-note text/i);
    expect(en['admin.peopleExport.notesBody']).toMatch(/email/i);
    expect(en['admin.peopleExport.notesBody']).toMatch(/secure/i);
    expect(en['admin.peopleExport.notesAudit']).toMatch(/identity/i);
    expect(en['admin.peopleExport.notesAudit']).toMatch(/time/i);
    expect(en['admin.peopleExport.notesAudit']).toMatch(/count/i);
    expect(en['admin.peopleExport.notesAudit']).toMatch(/note (?:text|body).*(?:never|not).*audit|never.*note (?:text|body).*audit/i);

    expect(zh['admin.peopleExport.notesBody']).toContain('敏感');
    expect(zh['admin.peopleExport.notesBody']).toMatch(/牧养记录全文|牧养记录正文/);
    expect(zh['admin.peopleExport.notesBody']).toContain('邮箱');
    expect(zh['admin.peopleExport.notesBody']).toContain('安全');
    expect(zh['admin.peopleExport.notesAudit']).toContain('身份');
    expect(zh['admin.peopleExport.notesAudit']).toContain('时间');
    expect(zh['admin.peopleExport.notesAudit']).toMatch(/数量|资料数量/);
    expect(zh['admin.peopleExport.notesAudit']).toMatch(/正文.*不会.*审计|不会.*正文.*审计/);
  });

  it('discloses D1 Free and maximum-import atomicity limits in both locales', () => {
    const enNotice = en['admin.peopleImport.d1Notice'];
    expect(enNotice).toMatch(/\b50\b/);
    expect(enNotice).toMatch(/\b500\b/);
    expect(enNotice).toMatch(/atomic/i);
    expect(enNotice).toMatch(/no partial|never partially|never.*partial/i);

    const zhNotice = zh['admin.peopleImport.d1Notice'];
    expect(zhNotice).toContain('50');
    expect(zhNotice).toContain('500');
    expect(zhNotice).toContain('原子');
    expect(zhNotice).toMatch(/不会.*部分|不.*部分写入/);
  });

  it('distinguishes an uncertain request result from a confirmed atomic import failure', () => {
    const enGeneric = en['admin.peopleImport.genericError'];
    expect(enGeneric).toMatch(/could not be confirmed/i);
    expect(enGeneric).toMatch(/check People/i);
    expect(enGeneric).toMatch(/preview.*before retrying/i);
    expect(enGeneric).not.toMatch(/nothing was written/i);
    expect(en['admin.peopleImport.result.import_failed']).toMatch(/nothing was written/i);

    const zhGeneric = zh['admin.peopleImport.genericError'];
    expect(zhGeneric).toContain('无法确认');
    expect(zhGeneric).toMatch(/检查.*会众/);
    expect(zhGeneric).toMatch(/重新预览.*重试/);
    expect(zhGeneric).not.toMatch(/没有写入任何|未写入任何/);
    expect(zh['admin.peopleImport.result.import_failed']).toMatch(/没有写入任何|未写入任何/);
  });

  it('warns that an uncertain mapping-profile save may have succeeded', () => {
    expect(en['admin.peopleImportMapping.failure.uncertainCreate']).toMatch(/may have been saved/i);
    expect(en['admin.peopleImportMapping.failure.uncertainCreate']).toMatch(/refresh/i);
    expect(zh['admin.peopleImportMapping.failure.uncertainCreate']).toMatch(/可能.*保存/);
    expect(zh['admin.peopleImportMapping.failure.uncertainCreate']).toContain('刷新');
  });

  it('states that an unexpected preview failure made no database changes', () => {
    expect(en['admin.peopleImport.previewError']).toMatch(/preview/i);
    expect(en['admin.peopleImport.previewError']).toMatch(/no (?:database )?(?:changes|writes)/i);
    expect(zh['admin.peopleImport.previewError']).toContain('预览');
    expect(zh['admin.peopleImport.previewError']).toMatch(/没有更改数据库|没有写入|未写入/);
  });
});

describe('t()', () => {
  it('looks up a key in the requested locale', () => {
    expect(t('en', 'site.name')).toBe('Church4Christ');
    expect(t('zh', 'site.name')).toBe('四方基督教会');
    expect(t('zh', 'nav.sermons')).toBe(zh['nav.sermons']);
  });

  it('returns literal dictionary text unchanged (trusted authored copy, not escaped)', () => {
    expect(t('en', 'nav.visit')).toBe(en['nav.visit']);
  });

  it('falls back to the key itself when the key is unknown in every locale', () => {
    expect(t('en', 'totally.unknown.key')).toBe('totally.unknown.key');
    expect(t('zh', 'totally.unknown.key')).toBe('totally.unknown.key');
  });

  it('interpolates {var} with strings and numbers', () => {
    // No seed key carries a placeholder, so the key-as-template fallback path
    // supplies the template — this exercises the interpolation branch directly.
    expect(t('en', 'Hi {name}', { name: 'Ada' })).toBe('Hi Ada');
    expect(t('en', 'Count: {n}', { n: 5 })).toBe('Count: 5');
  });

  it('leaves unmatched placeholders intact', () => {
    expect(t('en', 'Hi {name} and {other}', { name: 'Ada' })).toBe('Hi Ada and {other}');
  });

  it('HTML-escapes interpolated VALUES but never the surrounding literal text', () => {
    // 'Q&A ' is literal template text (its & must stay a bare &); the value
    // carries all five escapable characters and must be fully escaped.
    const out = t('en', 'Q&A {v}', { v: `<a href="x">&'` });
    expect(out).toBe(`Q&A &lt;a href=&quot;x&quot;&gt;&amp;&#39;`);
  });
});

// FormData parsers for the admin surfaces. Every parser returns either
// { ok: true, data } or { ok: false, errors }, where each error value is a
// dictionary KEY (e.g. 'errors.dateFormat') rendered through t() at display
// time — never localized prose. Repeatable rows arrive as parallel getAll()
// arrays (program_item / program_content / program_person, …); rows where every
// field is blank are silently skipped (never an error). All user-entered URLs
// are http(s)-only; dates are strict YYYY-MM-DD; datetime-local values are
// converted to UTC SQL strings.
import { isValidDateStr, datetimeLocalToUtc, todayInTz } from './dates';
import { extractYouTubeId } from './youtube';
import { LOCALES, type Locale } from './locales';
import { THEMES } from './theme';
import { MODULE_KEYS } from './modules';
import { parseAmountToCents } from './givingCheckout';

export type FormResult<T> = { ok: true; data: T } | { ok: false; errors: Record<string, string> };

// Error dictionary keys (defined in src/i18n/{en,zh}.ts, parity-enforced).
const ERR = {
  required: 'errors.required',
  date: 'errors.dateFormat',
  dateFuture: 'errors.dateFuture',
  tooLong: 'errors.tooLong',
  url: 'errors.urlInvalid',
  datetime: 'errors.datetimeInvalid',
  youtube: 'errors.youtubeInvalid',
  integer: 'errors.integerInvalid',
  email: 'errors.emailInvalid',
  option: 'errors.invalidOption',
  timePair: 'errors.timePair',
  amount: 'errors.amountInvalid',
} as const;

const ROLES = ['member', 'editor', 'admin'] as const;
type Role = (typeof ROLES)[number];

/** Membership lifecycle statuses (people.membership_status). Admin-set only. */
export const MEMBERSHIP_STATUSES = ['visitor', 'regular', 'member', 'inactive'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** http(s) only — carry-over security requirement for every user-entered URL. */
export function isHttpUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function str(fd: FormData, name: string): string {
  return String(fd.get(name) ?? '').trim();
}
function strs(fd: FormData, name: string): string[] {
  return fd.getAll(name).map((v) => String(v).trim());
}
function statusOf(fd: FormData): 'draft' | 'published' {
  return fd.get('status') === 'published' ? 'published' : 'draft';
}
function checkbox(fd: FormData, name: string): boolean {
  return fd.get(name) !== null;
}

/** Required positive integer id (e.g. a <select> of service types). */
function requiredId(fd: FormData, name: string, errors: Record<string, string>): number {
  const raw = str(fd, name);
  if (/^\d+$/.test(raw)) return Number(raw);
  errors[name] = ERR.required;
  return 0;
}

function sortOf(fd: FormData, errors: Record<string, string>): number {
  const raw = str(fd, 'sort');
  if (raw === '') return 0;
  if (!/^-?\d+$/.test(raw)) {
    errors.sort = ERR.integer;
    return 0;
  }
  return Number(raw);
}

function optionalDate(fd: FormData, name: string, errors: Record<string, string>): string | null {
  const raw = str(fd, name);
  if (raw === '') return null;
  if (!isValidDateStr(raw)) {
    errors[name] = ERR.date;
    return null;
  }
  return raw;
}

/** Optional YYYY-MM-DD that must be a real date and not in the future (e.g. a birthday). */
function optionalPastDate(fd: FormData, name: string, errors: Record<string, string>): string | null {
  const raw = str(fd, name);
  if (raw === '') return null;
  if (!isValidDateStr(raw)) {
    errors[name] = ERR.date;
    return null;
  }
  if (raw > todayInTz()) {
    errors[name] = ERR.dateFuture;
    return null;
  }
  return raw;
}

function publishAtOf(fd: FormData, errors: Record<string, string>): string | null {
  const raw = str(fd, 'publish_at');
  if (raw === '') return null;
  const utc = datetimeLocalToUtc(raw);
  if (utc === null) {
    errors.publish_at = ERR.datetime;
    return null;
  }
  return utc;
}

/** label/value row pairs → array; rows blank in BOTH fields are skipped. */
function pairRows(fd: FormData, labelName: string, valueName: string): { label: string; value: string }[] {
  const labels = strs(fd, labelName);
  const values = strs(fd, valueName);
  const out: { label: string; value: string }[] = [];
  for (let i = 0; i < Math.max(labels.length, values.length); i++) {
    const label = labels[i] ?? '';
    const value = values[i] ?? '';
    if (label || value) out.push({ label, value });
  }
  return out;
}

/** Collect per-locale text from `${base}_en` / `${base}_zh`; only non-empty locales are kept. */
function localeTexts(fd: FormData, base: string): Partial<Record<Locale, string>> {
  const out: Partial<Record<Locale, string>> = {};
  for (const loc of LOCALES) {
    const v = str(fd, `${base}_${loc}`);
    if (v) out[loc] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bulletin
// ---------------------------------------------------------------------------
export interface ProgramRow {
  item: string;
  content: string;
  person: string;
}
export interface OfferingRow {
  label: string;
  amount: string;
}
export interface AttendanceRow {
  label: string;
  count: string;
}
export interface BulletinAnnouncementInput {
  title: string;
  body: string;
  linkUrl: string | null;
  linkLabel: string | null;
}
export interface BulletinInput {
  serviceTypeId: number;
  bulletinDate: string;
  serviceTimeLabel: string | null;
  program: ProgramRow[];
  offering: OfferingRow[];
  attendance: AttendanceRow[];
  memoryVerse: string | null;
  flowers: string | null;
  status: 'draft' | 'published';
  publishAt: string | null;
  announcements: BulletinAnnouncementInput[];
}

export function parseBulletinForm(fd: FormData): FormResult<BulletinInput> {
  const errors: Record<string, string> = {};
  const serviceTypeId = requiredId(fd, 'service_type_id', errors);
  const bulletinDate = str(fd, 'bulletin_date');
  if (!isValidDateStr(bulletinDate)) errors.bulletin_date = ERR.date;
  const serviceTimeLabel = str(fd, 'service_time_label') || null;

  const items = strs(fd, 'program_item');
  const contents = strs(fd, 'program_content');
  const persons = strs(fd, 'program_person');
  const program: ProgramRow[] = [];
  for (let i = 0; i < Math.max(items.length, contents.length, persons.length); i++) {
    const row = { item: items[i] ?? '', content: contents[i] ?? '', person: persons[i] ?? '' };
    if (row.item || row.content || row.person) program.push(row);
  }

  const offering = pairRows(fd, 'offering_label', 'offering_amount').map((r) => ({ label: r.label, amount: r.value }));
  const attendance = pairRows(fd, 'attendance_label', 'attendance_count').map((r) => ({ label: r.label, count: r.value }));

  const annTitles = strs(fd, 'ann_title');
  const annBodies = strs(fd, 'ann_body');
  const annUrls = strs(fd, 'ann_url');
  const annLabels = strs(fd, 'ann_label');
  const announcements: BulletinAnnouncementInput[] = [];
  const annLen = Math.max(annTitles.length, annBodies.length, annUrls.length, annLabels.length);
  for (let i = 0; i < annLen; i++) {
    const title = annTitles[i] ?? '';
    const body = annBodies[i] ?? '';
    const url = annUrls[i] ?? '';
    const label = annLabels[i] ?? '';
    if (!title && !body && !url && !label) continue;
    if (!body) errors[`ann_body_${i}`] = ERR.required;
    if (url && !isHttpUrl(url)) errors[`ann_url_${i}`] = ERR.url;
    announcements.push({ title, body, linkUrl: url || null, linkLabel: label || null });
  }

  const status = statusOf(fd);
  const publishAt = publishAtOf(fd, errors);
  const memoryVerse = str(fd, 'memory_verse') || null;
  const flowers = str(fd, 'flowers') || null;

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      serviceTypeId,
      bulletinDate,
      serviceTimeLabel,
      program,
      offering,
      attendance,
      memoryVerse,
      flowers,
      status,
      publishAt,
      announcements,
    },
  };
}

// ---------------------------------------------------------------------------
// Sermon
// ---------------------------------------------------------------------------
export interface SermonInput {
  serviceTypeId: number;
  sermonDate: string;
  title: string;
  speaker: string;
  scripture: string | null;
  youtubeId: string | null;
  series: string | null;
  status: 'draft' | 'published';
}

export function parseSermonForm(fd: FormData): FormResult<SermonInput> {
  const errors: Record<string, string> = {};
  const serviceTypeId = requiredId(fd, 'service_type_id', errors);
  const sermonDate = str(fd, 'sermon_date');
  if (!isValidDateStr(sermonDate)) errors.sermon_date = ERR.date;
  const title = str(fd, 'title');
  if (!title) errors.title = ERR.required;
  const speaker = str(fd, 'speaker');

  // youtube optional; when supplied it must resolve to a valid id.
  const youtubeRaw = str(fd, 'youtube');
  let youtubeId: string | null = null;
  if (youtubeRaw) {
    youtubeId = extractYouTubeId(youtubeRaw);
    if (!youtubeId) errors.youtube = ERR.youtube;
  }

  const scripture = str(fd, 'scripture') || null;
  const series = str(fd, 'series') || null;
  const status = statusOf(fd);

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { serviceTypeId, sermonDate, title, speaker, scripture, youtubeId, series, status } };
}

// ---------------------------------------------------------------------------
// Prayer sheet
// ---------------------------------------------------------------------------
export interface PrayerSection {
  heading: string;
  items: string[];
}
export interface PrayerSheetInput {
  sheetDate: string;
  locale: Locale | null;
  sections: PrayerSection[];
  status: 'draft' | 'published';
  publishAt: string | null;
}

export function parsePrayerSheetForm(fd: FormData): FormResult<PrayerSheetInput> {
  const errors: Record<string, string> = {};
  const sheetDate = str(fd, 'sheet_date');
  if (!isValidDateStr(sheetDate)) errors.sheet_date = ERR.date;

  const localeRaw = str(fd, 'locale');
  let locale: Locale | null = null;
  if (localeRaw) {
    if ((LOCALES as readonly string[]).includes(localeRaw)) locale = localeRaw as Locale;
    else errors.locale = ERR.option;
  }

  const headings = strs(fd, 'section_heading');
  const itemBlocks = fd.getAll('section_items').map((v) => String(v));
  const sections: PrayerSection[] = [];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i] ?? '';
    const items = (itemBlocks[i] ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!heading && items.length === 0) continue; // fully-empty section → skipped
    if (!heading) errors[`section_heading_${i}`] = ERR.required;
    sections.push({ heading, items });
  }

  const status = statusOf(fd);
  const publishAt = publishAtOf(fd, errors);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { sheetDate, locale, sections, status, publishAt } };
}

// ---------------------------------------------------------------------------
// Home announcements (i18n titles)
// ---------------------------------------------------------------------------
export interface AnnouncementInput {
  titles: Partial<Record<Locale, string>>;
  url: string | null;
  sort: number;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export function parseAnnouncementForm(fd: FormData): FormResult<AnnouncementInput> {
  const errors: Record<string, string> = {};
  const titles = localeTexts(fd, 'title');
  if (Object.keys(titles).length === 0) errors.title = ERR.required;
  const url = str(fd, 'url');
  if (url && !isHttpUrl(url)) errors.url = ERR.url;
  const sort = sortOf(fd, errors);
  const active = checkbox(fd, 'active');
  const startsAt = optionalDate(fd, 'starts_at', errors);
  const endsAt = optionalDate(fd, 'ends_at', errors);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { titles, url: url || null, sort, active, startsAt, endsAt } };
}

// ---------------------------------------------------------------------------
// Events (i18n title + blurb)
// ---------------------------------------------------------------------------
export interface EventInput {
  titles: Partial<Record<Locale, string>>;
  blurbs: Partial<Record<Locale, string>>;
  imageKey: string | null;
  url: string | null;
  sort: number;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export function parseEventForm(fd: FormData): FormResult<EventInput> {
  const errors: Record<string, string> = {};
  const titles = localeTexts(fd, 'title');
  if (Object.keys(titles).length === 0) errors.title = ERR.required;
  // Blurbs are stored only for locales that actually carry a title.
  const blurbs: Partial<Record<Locale, string>> = {};
  for (const loc of LOCALES) {
    if (titles[loc] === undefined) continue;
    const b = str(fd, `blurb_${loc}`);
    if (b) blurbs[loc] = b;
  }
  const url = str(fd, 'url');
  if (url && !isHttpUrl(url)) errors.url = ERR.url;
  const sort = sortOf(fd, errors);
  const active = checkbox(fd, 'active');
  const startsAt = optionalDate(fd, 'starts_at', errors);
  const endsAt = optionalDate(fd, 'ends_at', errors);
  // image_key is a hidden field carrying the CURRENT key; the events page
  // overwrites it after a successful upload or on removal.
  const imageKey = str(fd, 'image_key') || null;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { titles, blurbs, imageKey, url: url || null, sort, active, startsAt, endsAt } };
}

// ---------------------------------------------------------------------------
// People (member / editor / admin superset)
// ---------------------------------------------------------------------------
export interface PersonInput {
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  phone: string | null;
  role: Role;
  active: boolean;
  lang: Locale | null;
  birthday: string | null;
  address: string | null;
  // Admin-only fields — present only when parsePersonForm is called with
  // { admin: true }. membership_status/joined_on are never self-service.
  membershipStatus?: MembershipStatus;
  joinedOn?: string | null;
}

/**
 * Parse the person form. Both variants read birthday (optional, not future) and
 * address (≤200 chars). With `{ admin: true }` it additionally reads
 * membership_status (enum, defaults 'visitor') and joined_on (optional date) —
 * these are admin-set only and must stay absent on the self-service surface.
 */
export function parsePersonForm(fd: FormData, opts: { admin?: boolean } = {}): FormResult<PersonInput> {
  const errors: Record<string, string> = {};
  const firstName = str(fd, 'first_name');
  const lastName = str(fd, 'last_name');
  const displayName = str(fd, 'display_name');
  if (!displayName) errors.display_name = ERR.required;

  // people.email is stored lowercased/trimmed and is required + valid.
  const email = str(fd, 'email').toLowerCase();
  if (!email) errors.email = ERR.required;
  else if (!isEmail(email)) errors.email = ERR.email;

  const phone = str(fd, 'phone') || null;

  const roleRaw = str(fd, 'role');
  let role: Role = 'member';
  if ((ROLES as readonly string[]).includes(roleRaw)) role = roleRaw as Role;
  else errors.role = ERR.option;

  const active = checkbox(fd, 'active');

  const langRaw = str(fd, 'lang');
  let lang: Locale | null = null;
  if (langRaw) {
    if ((LOCALES as readonly string[]).includes(langRaw)) lang = langRaw as Locale;
    else errors.lang = ERR.option;
  }

  const birthday = optionalPastDate(fd, 'birthday', errors);
  const addressRaw = str(fd, 'address');
  if (addressRaw.length > 200) errors.address = ERR.tooLong;
  const address = addressRaw || null;

  const data: PersonInput = { firstName, lastName, displayName, email, phone, role, active, lang, birthday, address };

  if (opts.admin) {
    const statusRaw = str(fd, 'membership_status');
    if (statusRaw === '') data.membershipStatus = 'visitor';
    else if ((MEMBERSHIP_STATUSES as readonly string[]).includes(statusRaw)) {
      data.membershipStatus = statusRaw as MembershipStatus;
    } else errors.membership_status = ERR.option;
    data.joinedOn = optionalDate(fd, 'joined_on', errors);
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Households (self-service + admin household cards)
// ---------------------------------------------------------------------------
export interface HouseholdFormInput {
  name: string;
  address: string | null;
  phone: string | null;
}

/** Household card form: name required (≤80), address (≤200) and phone (≤40) optional. */
export function parseHouseholdForm(fd: FormData): FormResult<HouseholdFormInput> {
  const errors: Record<string, string> = {};
  const name = str(fd, 'name');
  if (!name) errors.name = ERR.required;
  else if (name.length > 80) errors.name = ERR.tooLong;

  const addressRaw = str(fd, 'address');
  if (addressRaw.length > 200) errors.address = ERR.tooLong;

  const phoneRaw = str(fd, 'phone');
  if (phoneRaw.length > 40) errors.phone = ERR.tooLong;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { name, address: addressRaw || null, phone: phoneRaw || null } };
}

export interface DependentFormInput {
  displayName: string;
  role: 'adult' | 'child';
}

/** Name-only dependent form: display_name required (≤80), role adult/child (defaults adult). */
export function parseDependentForm(fd: FormData): FormResult<DependentFormInput> {
  const errors: Record<string, string> = {};
  const displayName = str(fd, 'display_name');
  if (!displayName) errors.display_name = ERR.required;
  else if (displayName.length > 80) errors.display_name = ERR.tooLong;

  const roleRaw = str(fd, 'role');
  let role: 'adult' | 'child' = 'adult';
  if (roleRaw === 'child') role = 'child';
  else if (roleRaw !== '' && roleRaw !== 'adult') errors.role = ERR.option;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { displayName, role } };
}

// ---------------------------------------------------------------------------
// Blockout dates (volunteer self-service, /my/blockouts)
// ---------------------------------------------------------------------------
export type BlockoutRepeat = 'none' | 'weekly' | 'biweekly';

export interface BlockoutInput {
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
  repeat: BlockoutRepeat;
  /** Occurrences to materialize when repeating; clamped to 2..26, else 1. */
  count: number;
}

const TIME_RE = /^\d{2}:\d{2}$/;

/**
 * Parse the add-blockout form. End date defaults to the start date. The time
 * pair is optional (blank = whole day blocked), but a HALF-filled pair — only
 * one side, a malformed value, or end <= start — is a mistake, not an all-day
 * block, so it is rejected with `errors.timePair` rather than silently dropped.
 * A repeat of weekly/biweekly clamps count to 2..26 (default 4); 'none' → 1.
 */
export function parseBlockoutForm(fd: FormData): FormResult<BlockoutInput> {
  const errors: Record<string, string> = {};
  const startDate = str(fd, 'start_date');
  const endDate = str(fd, 'end_date') || startDate;
  if (!isValidDateStr(startDate) || !isValidDateStr(endDate) || endDate < startDate) {
    errors.start_date = ERR.date;
  }

  const st = str(fd, 'start_time');
  const et = str(fd, 'end_time');
  let startTime: string | null = null;
  let endTime: string | null = null;
  if (st !== '' || et !== '') {
    if (!TIME_RE.test(st) || !TIME_RE.test(et) || et <= st) errors.start_time = ERR.timePair;
    else {
      startTime = st;
      endTime = et;
    }
  }

  const repeatRaw = str(fd, 'repeat');
  const repeat: BlockoutRepeat = repeatRaw === 'weekly' || repeatRaw === 'biweekly' ? repeatRaw : 'none';
  const countRaw = Number(str(fd, 'count'));
  const count =
    repeat === 'none' ? 1 : Math.min(26, Math.max(2, Number.isInteger(countRaw) && countRaw > 0 ? countRaw : 4));

  const reason = str(fd, 'reason') || null;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { startDate, endDate, startTime, endTime, reason, repeat, count } };
}

// ---------------------------------------------------------------------------
// Serve application (/serve/apply — public)
// ---------------------------------------------------------------------------
export interface ApplicationInput {
  teamId: number;
  positionId: number | null;
  name: string;
  email: string;
  phone: string | null;
  message: string | null;
}

/**
 * Parse the apply form. team_id is always required; name + a valid email are
 * required only for a signed-out applicant (a signed-in user applies as
 * themselves and the page ignores these fields). position_id is optional and
 * the page re-validates it against the chosen team's positions.
 */
export function parseApplicationForm(fd: FormData, signedIn: boolean): FormResult<ApplicationInput> {
  const errors: Record<string, string> = {};
  const teamId = requiredId(fd, 'team_id', errors);

  const posRaw = str(fd, 'position_id');
  const positionId = /^\d+$/.test(posRaw) ? Number(posRaw) : null;

  const name = str(fd, 'name');
  const email = str(fd, 'email').toLowerCase();
  if (!signedIn) {
    if (!name) errors.name = ERR.required;
    if (!email) errors.email = ERR.required;
    else if (!isEmail(email)) errors.email = ERR.email;
  }
  const phone = str(fd, 'phone') || null;
  const message = str(fd, 'message') || null;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { teamId, positionId, name, email, phone, message } };
}

// ---------------------------------------------------------------------------
// Settings (fixed allowlist of dotted keys)
// ---------------------------------------------------------------------------
const SETTINGS_KEYS = [
  'site.name.en',
  'site.name.zh',
  'site.tagline.en',
  'site.tagline.zh',
  'site.address',
  'site.email',
  'site.phone',
  'site.map_url',
  'site.giving_url',
  'site.youtube_url',
  'site.hero_image_key',
  'site.service_times.en',
  'site.service_times.zh',
  'theme.name',
  'theme.default_mode',
  'locale.default',
] as const;
const SETTINGS_URL_KEYS = new Set(['site.map_url', 'site.giving_url', 'site.youtube_url']);
const THEME_MODES = ['light', 'dark'];
// `module.<key>` toggles ('0' | '1') — the Modules panel checkboxes. Present in
// the allowlist so a checked box (posts '1') validates; unchecked boxes are
// absent and the panel's save handler writes '0' for them (full 11-key write).
const MODULE_SETTING_KEYS = new Set(MODULE_KEYS.map((k) => `module.${k}`));
const MODULE_VALUES = ['0', '1'];

/**
 * Parse the settings admin form. Only allowlisted keys present in the form are
 * read (partial updates are fine); URL / email / enum / module-toggle keys are
 * validated, all others pass through as trimmed free text.
 */
export function parseSettingsForm(fd: FormData): FormResult<Record<string, string>> {
  const errors: Record<string, string> = {};
  const data: Record<string, string> = {};
  for (const key of [...SETTINGS_KEYS, ...MODULE_SETTING_KEYS]) {
    if (!fd.has(key)) continue;
    const value = str(fd, key);
    if (MODULE_SETTING_KEYS.has(key)) {
      if (!MODULE_VALUES.includes(value)) errors[key] = ERR.option;
    } else if (SETTINGS_URL_KEYS.has(key)) {
      if (value && !isHttpUrl(value)) errors[key] = ERR.url;
    } else if (key === 'site.email') {
      if (value && !isEmail(value)) errors[key] = ERR.email;
    } else if (key === 'theme.name') {
      if (!(THEMES as readonly string[]).includes(value)) errors[key] = ERR.option;
    } else if (key === 'theme.default_mode') {
      if (!THEME_MODES.includes(value)) errors[key] = ERR.option;
    } else if (key === 'locale.default') {
      if (!(LOCALES as readonly string[]).includes(value)) errors[key] = ERR.option;
    }
    data[key] = value;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Giving admin — funds + manual check/cash entry (finance ∪ admin surfaces).
// Pure FormData parsing so it unit-tests away from the request lifecycle; money
// crosses as integer cents via parseAmountToCents (never a float).
// ---------------------------------------------------------------------------
export interface FundFormInput {
  fund_number: string;
  name_en: string;
  name_zh: string;
  active: boolean;
  sort: number;
}

/** Fund create/edit form: fund_number + English name required; the Chinese name
 *  is optional (getFund/listFunds fall back to en), sort defaults to 0. */
export function parseFundForm(fd: FormData): FormResult<FundFormInput> {
  const errors: Record<string, string> = {};
  const fund_number = str(fd, 'fund_number');
  if (!fund_number) errors.fund_number = ERR.required;
  const name_en = str(fd, 'name_en');
  if (!name_en) errors.name_en = ERR.required;
  const name_zh = str(fd, 'name_zh');
  const active = checkbox(fd, 'active');
  const sort = sortOf(fd, errors);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { fund_number, name_en, name_zh, active, sort } };
}

export interface ManualGiftInput {
  personId: number | null;
  donorName: string | null;
  fundId: number;
  amountCents: number;
  method: 'check' | 'cash';
  checkNumber: string | null;
  receivedOn: string;
  note: string | null;
}

/**
 * Parse a manual check/cash gift. fund + amount + method + received-on are all
 * required; the gift is attributed to EITHER a known member (person_id) or a
 * free-text donor name — at least one is required. check_number is kept only for
 * method 'check' (dropped for cash so a stray field never leaks onto a cash row).
 */
export function parseManualGiftForm(fd: FormData): FormResult<ManualGiftInput> {
  const errors: Record<string, string> = {};

  const fundId = requiredId(fd, 'fund_id', errors);

  const amountCents = parseAmountToCents(str(fd, 'amount'));
  if (amountCents === null) errors.amount = ERR.amount;

  const methodRaw = str(fd, 'method');
  const method = methodRaw === 'check' || methodRaw === 'cash' ? methodRaw : null;
  if (!method) errors.method = ERR.option;

  const receivedOn = str(fd, 'received_on');
  if (receivedOn === '') errors.received_on = ERR.required;
  else if (!isValidDateStr(receivedOn)) errors.received_on = ERR.date;

  const personRaw = str(fd, 'person_id');
  const personId = /^\d+$/.test(personRaw) ? Number(personRaw) : null;
  const donorName = str(fd, 'donor_name') || null;
  if (personId === null && donorName === null) errors.donor = ERR.required;

  const checkNumber = method === 'check' ? str(fd, 'check_number') || null : null;
  const note = str(fd, 'note') || null;

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      personId,
      donorName,
      fundId,
      amountCents: amountCents as number,
      method: method as 'check' | 'cash',
      checkNumber,
      receivedOn,
      note,
    },
  };
}

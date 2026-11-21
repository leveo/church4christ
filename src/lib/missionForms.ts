// Mission trip editor parsing (pure; unit-tested). Error values are dictionary keys.
import { isValidDateStr } from './dates';
import { SUPPORTED_LOCALES, type SupportedLocale } from './locales';
import { extractYouTubeId } from './youtube';
import { parseFundField } from './pledgeForms';
import { TRIP_STATUSES, TRIP_TEXT_FIELDS, type TripInput, type TripStatus, type TripText } from './missionDb';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX: Record<(typeof TRIP_TEXT_FIELDS)[number], number> = { title: 200, location: 200, summary: 600, story_md: 20000, team_note: 1000 };

function str(fd: FormData, key: string, max: number): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim().slice(0, max + 1) : '';
}

export function parseTripForm(fd: FormData): { ok: true; value: TripInput } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const slug = str(fd, 'slug', 80).toLowerCase();
  if (!SLUG_RE.test(slug) || slug.length > 80) errors.slug = 'missions.admin.err.slug';
  const status = str(fd, 'status', 12) as TripStatus;
  if (!(TRIP_STATUSES as readonly string[]).includes(status)) errors.status = 'missions.admin.err.status';
  const year = Number(str(fd, 'year', 4));
  if (!Number.isInteger(year) || year < 1900 || year > 2200) errors.year = 'missions.admin.err.year';

  const date = (key: string): string | null => {
    const v = str(fd, key, 10);
    if (!v) return null;
    if (!isValidDateStr(v)) errors[key] = 'missions.admin.err.date';
    return v;
  };
  const startDate = date('start_date');
  const endDate = date('end_date');
  if (startDate && endDate && !errors.start_date && !errors.end_date && endDate < startDate) errors.end_date = 'missions.admin.err.dateOrder';

  const countryRaw = str(fd, 'country_code', 2).toUpperCase();
  if (countryRaw && !/^[A-Z]{2}$/.test(countryRaw)) errors.country_code = 'missions.admin.err.country';

  // Both coordinates or neither: a trip without them is listed but gets no pin.
  const coord = (key: string, limit: number): number | null => {
    const v = str(fd, key, 20);
    if (!v) return null;
    const n = Number(v);
    if (!/^-?\d{1,3}(?:\.\d{1,6})?$/.test(v) || !Number.isFinite(n) || Math.abs(n) > limit) {
      errors[key] = 'missions.admin.err.coordinate';
      return null;
    }
    return n;
  };
  const latitude = coord('latitude', 90);
  const longitude = coord('longitude', 180);
  if ((latitude === null) !== (longitude === null) && !errors.latitude && !errors.longitude) errors.latitude = 'missions.admin.err.coordinatePair';

  const teamRaw = str(fd, 'team_size', 5);
  let teamSize: number | null = null;
  if (teamRaw) {
    teamSize = Number(teamRaw);
    if (!Number.isInteger(teamSize) || teamSize < 0 || teamSize > 10000) errors.team_size = 'missions.admin.err.teamSize';
  }

  const videoRaw = str(fd, 'video_url', 300);
  let videoUrl: string | null = null;
  if (videoRaw) {
    if (!extractYouTubeId(videoRaw)) errors.video_url = 'missions.admin.err.video';
    else videoUrl = videoRaw;
  }

  const text: Partial<Record<SupportedLocale, TripText>> = {};
  for (const code of SUPPORTED_LOCALES) {
    if (!TRIP_TEXT_FIELDS.some((f) => fd.has(`${f}_${code}`))) continue;
    const entry = {} as TripText;
    for (const f of TRIP_TEXT_FIELDS) {
      entry[f] = str(fd, `${f}_${code}`, MAX[f]);
      if (entry[f].length > MAX[f]) errors[f] = 'missions.admin.err.tooLong';
    }
    text[code] = entry;
  }
  if (!Object.values(text).some((x) => x && x.title)) errors.title = 'missions.admin.err.title';

  const fundId = parseFundField(fd);
  if (fundId === 'invalid') errors.fund_id = 'missions.admin.err.fund';

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: { ...(fundId !== undefined && fundId !== 'invalid' ? { fundId } : {}), slug, status, year, startDate, endDate, countryCode: countryRaw || null, latitude, longitude, teamSize, videoUrl, text },
  };
}

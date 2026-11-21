// Missions: pure map/stat helpers, the editor parser, and the data layer
// against a live D1 (drafts and their photos never reach public reads).
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { countryName, groupByYear, projectPin, tripStats } from '../src/lib/missionMap';
import { parseTripForm } from '../src/lib/missionForms';
import {
  addTripPhoto,
  createTrip,
  deleteTrip,
  getPublishedTrip,
  getTrip,
  getTripTexts,
  listPublishedTripPhotos,
  listPublishedTrips,
  listTrips,
  MAX_TRIP_PHOTOS,
  updateTrip,
  type TripInput,
} from '../src/lib/missionDb';

describe('map helpers', () => {
  it('projects coordinates onto the equirectangular outline', () => {
    expect(projectPin(0, 0)).toEqual({ left: 50, top: 50 });
    expect(projectPin(90, -180)).toEqual({ left: 0, top: 0 });
    expect(projectPin(-1.29, 36.82)).toEqual({ left: 60.23, top: 50.72 });
    expect(projectPin(200, 500)).toEqual({ left: 100, top: 0 });
  });
  it('names countries in the reader language and ignores bad codes', () => {
    expect(countryName('KE', 'en')).toBe('Kenya');
    expect(countryName('ke', 'en')).toBe('');
    expect(countryName(null, 'en')).toBe('');
  });
  it('counts trips, distinct countries and the year span, and groups newest year first', () => {
    const trips = [{ year: 2019, country_code: 'DE' }, { year: 2026, country_code: 'KE' }, { year: 2026, country_code: 'KE' }, { year: 2024, country_code: null }];
    expect(tripStats(trips)).toEqual({ trips: 4, countries: 2, firstYear: 2019, lastYear: 2026 });
    expect(tripStats([])).toEqual({ trips: 0, countries: 0, firstYear: null, lastYear: null });
    expect(groupByYear(trips).map((g) => [g.year, g.trips.length])).toEqual([[2026, 2], [2024, 1], [2019, 1]]);
  });
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const valid = {
  slug: 'kenya-2026', status: 'published', year: '2026', start_date: '2026-07-01', end_date: '2026-07-10',
  country_code: 'ke', latitude: '-1.29', longitude: '36.82', team_size: '8', video_url: 'https://youtu.be/dQw4w9WgXcQ',
  title_en: 'Kenya', location_en: 'Nairobi', summary_en: 'Serving schools.', story_md_en: 'We **went**.', team_note_en: '',
};

describe('parseTripForm', () => {
  it('parses a complete trip and uppercases the country', () => {
    const r = parseTripForm(form(valid));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.countryCode).toBe('KE');
      expect([r.value.latitude, r.value.longitude, r.value.teamSize]).toEqual([-1.29, 36.82, 8]);
      expect(r.value.text.en?.title).toBe('Kenya');
    }
  });
  it('allows a trip without coordinates (listed, no pin) but not half a coordinate', () => {
    expect(parseTripForm(form({ ...valid, latitude: '', longitude: '' })).ok).toBe(true);
    const half = parseTripForm(form({ ...valid, longitude: '' }));
    expect(!half.ok && half.errors.latitude).toBe('missions.admin.err.coordinatePair');
  });
  it('keeps the fund link out of a save that has no fund field, and parses one that has', () => {
    const without = parseTripForm(form(valid));
    expect(without.ok && 'fundId' in without.value).toBe(false);
    const withFund = parseTripForm(form({ ...valid, fund_id: '12' }));
    expect(withFund.ok && withFund.value.fundId).toBe(12);
    const cleared = parseTripForm(form({ ...valid, fund_id: '' }));
    expect(cleared.ok && cleared.value.fundId).toBeNull();
    const bad = parseTripForm(form({ ...valid, fund_id: 'x' }));
    expect(!bad.ok && bad.errors.fund_id).toBe('missions.admin.err.fund');
  });

  it('rejects bad values with field errors', () => {
    const r = parseTripForm(form({ ...valid, slug: 'Bad!', year: '1800', end_date: '2026-06-01', country_code: 'K1', latitude: '91', video_url: 'https://example.org/v', title_en: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toMatchObject({
        slug: 'missions.admin.err.slug', year: 'missions.admin.err.year', end_date: 'missions.admin.err.dateOrder',
        country_code: 'missions.admin.err.country', latitude: 'missions.admin.err.coordinate',
        video_url: 'missions.admin.err.video', title: 'missions.admin.err.title',
      });
    }
  });
});

const db = env.DB;
const base: TripInput = {
  slug: 'kenya-2026', status: 'published', year: 2026, startDate: '2026-07-01', endDate: null, countryCode: 'KE',
  latitude: -1.29, longitude: 36.82, teamSize: 8, videoUrl: null,
  text: { en: { title: 'Kenya', location: 'Nairobi', summary: 's', story_md: '', team_note: '' }, zh: { title: '肯尼亚', location: '内罗毕', summary: '', story_md: '', team_note: '' } },
};

describe('missionDb', () => {
  beforeEach(async () => {
    await db.batch([db.prepare('DELETE FROM mission_trip_photos'), db.prepare('DELETE FROM mission_trip_i18n'), db.prepare('DELETE FROM mission_trips')]);
  });

  it('reads localized text with fallback and keeps drafts out of public reads', async () => {
    const id = await createTrip(db, base);
    const draft = await createTrip(db, { ...base, slug: 'secret', status: 'draft', year: 2027 });
    expect((await getTrip(db, id, 'zh'))?.title).toBe('肯尼亚');
    expect((await getTrip(db, id, 'ko'))?.title).toBe('Kenya');
    expect((await getTripTexts(db, id)).zh?.location).toBe('内罗毕');
    expect((await listTrips(db, 'en')).map((t) => t.slug)).toEqual(['secret', 'kenya-2026']);
    expect((await listPublishedTrips(db, 'en')).map((t) => t.slug)).toEqual(['kenya-2026']);
    expect(await getPublishedTrip(db, 'secret', 'en')).toBeNull();
    await addTripPhoto(db, draft, 'uploads/x.jpg');
    expect(await listPublishedTripPhotos(db, draft)).toEqual([]);
    const trip = await getPublishedTrip(db, 'kenya-2026', 'en');
    expect([trip?.latitude, trip?.team_size]).toEqual([-1.29, 8]);
  });

  it('updates, caps the gallery, and deletes with its rows', async () => {
    const id = await createTrip(db, base);
    await updateTrip(db, id, { ...base, status: 'draft', latitude: null, longitude: null });
    expect(await listPublishedTrips(db, 'en')).toEqual([]);
    expect((await getTrip(db, id, 'en'))?.latitude).toBeNull();
    for (let i = 0; i < MAX_TRIP_PHOTOS; i++) expect(await addTripPhoto(db, id, `uploads/${i}.jpg`)).toBe(true);
    expect(await addTripPhoto(db, id, 'uploads/extra.jpg')).toBe(false);
    await deleteTrip(db, id);
    expect(await getTrip(db, id, 'en')).toBeNull();
    const left = await db.prepare('SELECT COUNT(*) AS n FROM mission_trip_photos').first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

// Mission map helpers (pure). The land outline in
// public/images/missions/world-land.svg uses an equirectangular projection on a
// 1000 x 500 canvas; pins use the same formula, expressed as percentages so the
// map scales with its container. Country names come from the browser's own
// Intl.DisplayNames data, so no country list ships with the site.

export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 500;

/** Position of a coordinate on the map, as left/top percentages (0–100). */
export function projectPin(latitude: number, longitude: number): { left: number; top: number } {
  const lon = Math.max(-180, Math.min(180, longitude));
  const lat = Math.max(-90, Math.min(90, latitude));
  return {
    left: Math.round(((lon + 180) / 360) * 10000) / 100,
    top: Math.round(((90 - lat) / 180) * 10000) / 100,
  };
}

/** A country's name in the reader's language from its ISO 3166-1 alpha-2 code, or '' when unknown. */
export function countryName(code: string | null | undefined, bcp47: string): string {
  if (!code || !/^[A-Z]{2}$/.test(code)) return '';
  try {
    const name = new Intl.DisplayNames([bcp47], { type: 'region' }).of(code);
    return name && name !== code ? name : '';
  } catch {
    return '';
  }
}

export interface TripStatsInput {
  year: number;
  country_code: string | null;
}

/** Headline numbers for the public page: trips, distinct countries, and the year span. */
export function tripStats(trips: readonly TripStatsInput[]): { trips: number; countries: number; firstYear: number | null; lastYear: number | null } {
  const countries = new Set(trips.map((t) => t.country_code).filter((c): c is string => !!c));
  const years = trips.map((t) => t.year);
  return {
    trips: trips.length,
    countries: countries.size,
    firstYear: years.length ? Math.min(...years) : null,
    lastYear: years.length ? Math.max(...years) : null,
  };
}

/** Group trips by year, newest year first, keeping each year's given order. */
export function groupByYear<T extends { year: number }>(trips: readonly T[]): { year: number; trips: T[] }[] {
  const map = new Map<number, T[]>();
  for (const trip of trips) map.set(trip.year, [...(map.get(trip.year) ?? []), trip]);
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([year, list]) => ({ year, trips: list }));
}

// Pure, dependency-free locale-resolution core for content collections. Kept
// separate from content.ts (which imports 'astro:content') so it can be unit
// tested in the plain-node vitest project with plain fixtures — importing
// 'astro:content' outside the Astro build is not possible.
//
// Every collection entry `id` is '<locale>/<slug>' (the glob loader's folder +
// filename). Locale resolution: prefer the requested locale's entry, else fall
// back to the English one with translated=false; English callers always get
// translated=true when their entry exists.

/** Minimal shape these helpers need — Astro's CollectionEntry satisfies it. */
export interface HasId {
  id: string;
}

const EN = 'en';

/** Split an entry id ('zh/psalms-of-ascent') into its locale + slug parts. */
export function splitId(id: string): { locale: string; slug: string } {
  const slash = id.indexOf('/');
  if (slash === -1) return { locale: '', slug: id };
  return { locale: id.slice(0, slash), slug: id.slice(slash + 1) };
}

/** The slug (locale folder stripped) of an entry. */
export function slugOf(entry: HasId): string {
  return splitId(entry.id).slug;
}

/**
 * Resolve one slug for `locale` against a flat entry list. Returns the localized
 * entry (translated=true) when present, else the English entry (translated=false),
 * else null when neither exists.
 */
export function getLocalizedFrom<T extends HasId>(
  entries: T[],
  slug: string,
  locale: string,
): { entry: T; translated: boolean } | null {
  const exact = entries.find((e) => e.id === `${locale}/${slug}`);
  if (exact) return { entry: exact, translated: true };
  const fallback = entries.find((e) => e.id === `${EN}/${slug}`);
  if (fallback) return { entry: fallback, translated: false };
  return null;
}

/**
 * One resolved item per distinct slug, preferring the locale entry over its
 * English fallback (dedupe). Order is not guaranteed — callers sort by their own
 * field (date, order). Each item also carries its slug so callers can build hrefs.
 */
export function listLocalizedFrom<T extends HasId>(
  entries: T[],
  locale: string,
): { entry: T; translated: boolean; slug: string }[] {
  const slugs = new Set<string>();
  for (const e of entries) slugs.add(splitId(e.id).slug);

  const out: { entry: T; translated: boolean; slug: string }[] = [];
  for (const slug of slugs) {
    const resolved = getLocalizedFrom(entries, slug, locale);
    if (resolved) out.push({ ...resolved, slug });
  }
  return out;
}

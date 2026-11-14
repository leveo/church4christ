// Pure, dependency-free locale-resolution core for content collections. Kept
// separate from content.ts (which imports 'astro:content') so it can be unit
// tested in the plain-node vitest project with plain fixtures — importing
// 'astro:content' outside the Astro build is not possible.
//
// Every collection entry `id` is '<locale>/<slug>' (the glob loader's folder +
// filename). Locale resolution: prefer the requested locale's entry, else fall
// back along the chain (requested -> installation default -> en) with
// translated=false and `contentLocale` naming the language actually served.

import { fallbackChain } from './locales';

/** Minimal shape these helpers need — Astro's CollectionEntry satisfies it. */
export interface HasId {
  id: string;
  data?: { demo?: boolean };
}

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
 * Resolve one slug for `locale` against a flat entry list, walking `chain`
 * (default: requested -> installation default -> en). Returns the first entry
 * found; `translated` is true only for the requested locale's own entry and
 * `contentLocale` is the language of the entry returned. Null when none exists.
 */
export function getLocalizedFrom<T extends HasId>(
  entries: T[],
  slug: string,
  locale: string,
  includeDemo = true,
  chain: readonly string[] = fallbackChain(locale),
): { entry: T; translated: boolean; contentLocale: string } | null {
  const visible = (entry: T) => includeDemo || entry.data?.demo !== true;
  for (const code of chain) {
    const hit = entries.find((e) => e.id === `${code}/${slug}` && visible(e));
    if (hit) return { entry: hit, translated: code === locale, contentLocale: code };
  }
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
  includeDemo = true,
  chain?: readonly string[],
): { entry: T; translated: boolean; contentLocale: string; slug: string }[] {
  const slugs = new Set<string>();
  for (const e of entries) slugs.add(splitId(e.id).slug);

  const out: { entry: T; translated: boolean; contentLocale: string; slug: string }[] = [];
  for (const slug of slugs) {
    const resolved = getLocalizedFrom(entries, slug, locale, includeDemo, chain);
    if (resolved) out.push({ ...resolved, slug });
  }
  return out;
}

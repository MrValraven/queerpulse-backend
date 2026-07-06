import { randomBytes } from 'node:crypto';

/**
 * Converts arbitrary text into a URL-safe slug: strips accents (Unicode
 * NFKD normalization + combining-mark removal), lowercases, collapses any
 * run of non `[a-z0-9]` characters into a single hyphen, trims leading and
 * trailing hyphens, and truncates to 80 characters. Falls back to
 * `fallback` (default `'item'`) when the result would otherwise be empty.
 *
 * Mirrors `EventsService.generateUniqueSlug`'s normalize/replace chain so
 * every domain produces identically-shaped slugs.
 */
export function slugify(input: string, fallback = 'item'): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || fallback
  );
}

/**
 * Allocates a slug guaranteed to satisfy `exists(slug) === false`: returns
 * `base` when it's free, otherwise retries with `base-<6 hex chars>` until
 * `exists` reports the candidate is unclaimed.
 */
export async function allocateUniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  let slug = base;
  while (await exists(slug)) {
    slug = `${base}-${randomBytes(3).toString('hex')}`;
  }
  return slug;
}

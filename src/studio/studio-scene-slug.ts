import { STUDIO_DISCOVERY_LIMITS } from './studio.constants';

/** The base for a name that folds to fewer than 2 characters. */
export const SCENE_SLUG_FALLBACK_BASE = 'scene';

/** The last numbered suffix tried before the server answers 409. */
export const SCENE_SLUG_LAST_SUFFIX = 50;

/**
 * A scene slug from its name: accents folded, lowercased, every run of other
 * characters turned into one hyphen, hyphens trimmed from both ends, cut to
 * 60. Always matches `STUDIO_SCENE_SLUG_PATTERN`.
 */
export function sceneSlugBase(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = folded
    .slice(0, STUDIO_DISCOVERY_LIMITS.sceneSlugMaxLength)
    .replace(/-+$/, '');
  return cut.length >= STUDIO_DISCOVERY_LIMITS.sceneSlugMinLength
    ? cut
    : SCENE_SLUG_FALLBACK_BASE;
}

/** The base, then `-2` up to `-50`, each shortened to fit in 60. */
export function sceneSlugCandidates(base: string): string[] {
  const candidates = [base];
  for (
    let suffixNumber = 2;
    suffixNumber <= SCENE_SLUG_LAST_SUFFIX;
    suffixNumber += 1
  ) {
    const suffix = `-${suffixNumber}`;
    const stem = base
      .slice(0, STUDIO_DISCOVERY_LIMITS.sceneSlugMaxLength - suffix.length)
      .replace(/-+$/, '');
    candidates.push(`${stem}${suffix}`);
  }
  return candidates;
}

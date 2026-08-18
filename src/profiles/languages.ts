/**
 * The languages vocabulary, server-side. Mirrors `LANGUAGES`/`LANG_POOL` in
 * the frontend's `memberDirectoryFilter.data.ts`. ISO-style codes are
 * identical in every language (i18n sweep §6), so there is no label mapping
 * to keep in lockstep — just the closed set of codes the DTO range-checks
 * against and `profiles.languages` may hold.
 */
export const LANGUAGE_CODES = ['PT', 'EN', 'ES', 'FR', 'DE'] as const;

const LANGUAGE_SET: ReadonlySet<string> = new Set(LANGUAGE_CODES);

export function isLanguageCode(value: string): boolean {
  return LANGUAGE_SET.has(value);
}

export function knownLanguages(codes: readonly string[]): string[] {
  return [...new Set(codes.filter(isLanguageCode))];
}

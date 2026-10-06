/**
 * PRD-325: the closed set of interface languages a member can pick, stored on
 * `member_preferences.language` (see `AddMemberLanguagePreference1829700000000`,
 * whose CHECK constraint mirrors this exact set). The frontend's `Language`
 * union (`queerpulse/src/shared/i18n/types.ts`) holds the same two values.
 *
 * This module owns the set so the DTO validator
 * (`update-language-preference.dto.ts`), the entity and the push composer
 * (`PushPreviewPrivacyService`) agree on what a valid value is.
 *
 * The column is nullable on purpose. `null` means "this member has never told
 * the server", and the app answers it by writing up the language the device
 * already uses. A default of `'en'` would be indistinguishable from a member
 * who chose English, so a Portuguese speaker's first device could never seed it.
 */
export const MEMBER_LANGUAGE_VALUES = ['en', 'pt'] as const;

export type MemberLanguage = (typeof MEMBER_LANGUAGE_VALUES)[number];

export function isMemberLanguage(value: unknown): value is MemberLanguage {
  return value === 'en' || value === 'pt';
}

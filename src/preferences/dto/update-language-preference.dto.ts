import { IsIn } from 'class-validator';
import { MEMBER_LANGUAGE_VALUES, MemberLanguage } from '../member-language';

/**
 * `PUT /me/language` (PRD-325): the member's interface language, on its own.
 *
 * Required and closed: a member picks English or Portuguese. Clearing it back
 * to `null` has no use case (the app always holds a language) so the DTO
 * accepts exactly the two values the switcher offers.
 */
export class UpdateLanguagePreferenceDto {
  @IsIn(MEMBER_LANGUAGE_VALUES)
  language!: MemberLanguage;
}

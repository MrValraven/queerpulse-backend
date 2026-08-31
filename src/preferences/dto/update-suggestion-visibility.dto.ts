import { IsBoolean } from 'class-validator';

/**
 * `PUT /me/suggestion-visibility`: the single "stop recommending me to
 * strangers" switch (PRD-16).
 *
 * `hideFromSuggestions`, not `enabled`: the pane's label is "Appear in
 * suggested connections", so an `enabled` field would sit one careless
 * reading away from being wired backwards, and being wired backwards here
 * means the platform keeps pushing a member at strangers after they asked it
 * to stop. The field name matches the column and the query predicate, so the
 * value means the same thing at every layer it passes through.
 *
 * Turning it on removes the member from other people's suggestion strips and
 * nothing else. They keep seeing suggestions themselves, they stay in the
 * member directory, and their profile stays exactly as visible as
 * `profiles.visibility` says.
 */
export class UpdateSuggestionVisibilityDto {
  @IsBoolean()
  hideFromSuggestions!: boolean;
}

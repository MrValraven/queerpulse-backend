import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * The FE "suggest an edit" modal's fixed field picker. Kept as a closed set
 * (unlike `AskListingQuestionDto`'s free text) so the admin queue can
 * meaningfully group/filter suggestions by what's being corrected.
 */
export const EDIT_SUGGESTION_FIELDS = [
  'hours',
  'address',
  'phone',
  'website',
  'description',
  'other',
] as const;
export type EditSuggestionField = (typeof EDIT_SUGGESTION_FIELDS)[number];

/**
 * Body of `POST /listings/:ref/edit-suggestions` — any active non-owner
 * member proposing a correction to a business listing (the owner is blocked
 * server-side; see `ListingEditSuggestionsService.submit`). `message` is
 * trimmed and re-checked for emptiness server-side (mirrors
 * `ListingsService.replyToReview`'s post-trim guard — `@IsNotEmpty` alone
 * would pass a whitespace-only string through).
 */
export class CreateEditSuggestionDto {
  @IsString()
  @IsIn(EDIT_SUGGESTION_FIELDS)
  field!: EditSuggestionField;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message!: string;
}

import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsValidProposedSuggestionValue } from './proposed-suggestion-value.validator';

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

  /**
   * OPTIONAL typed replacement value: the exact new phone number, the exact new
   * closing time, the corrected address. Supplying one turns a moderator's job
   * from "read the prose and retype the value" into one click, which is the
   * common case, because the member reporting a wrong phone number usually
   * knows the right one.
   *
   * It stays optional on purpose. "The hours are wrong and I do not know what
   * they are now" is a genuinely useful report, so `message` remains required
   * and a submission carrying prose alone is completely valid.
   *
   * Validated at submit time against the SAME class-validator rules the real
   * `Listing` column enforces, through `IsValidProposedSuggestionValue` ->
   * `accepted-suggestion-value.ts`. That is deliberate: the accept path already
   * re-checks the value before writing it and silently declines to write one it
   * rejects, so without this check a member could submit a proposal that looked
   * accepted and quietly changed nothing. Checking here hands them the error
   * while the form is still open.
   *
   * THE `other` BUCKET REFUSES A PROPOSED VALUE. `other` is the catch-all for
   * corrections that map to no single listing column, so there is nothing a
   * typed replacement value could be written to; accepting one would mean
   * storing a value that can never be applied and showing moderators a
   * one-click "accept" that writes nothing. A `proposedValue` sent with
   * `field: 'other'` is rejected with a 400 that says so and points the member
   * at `message`. The same refusal covers any future picker entry that has no
   * writable column yet, since the entity stores `field` as a varchar so the
   * picker can grow without a migration.
   *
   * Trimmed before validation, and a value that is empty or whitespace-only
   * after trimming is treated as absent rather than as an error, so a form that
   * always posts the input can leave it blank. `@IsNotEmpty` still guards the
   * case where the transform did not run.
   */
  @IsOptional()
  @Transform((params: TransformFnParams) => {
    const raw: unknown = params.value;
    return typeof raw === 'string' ? raw.trim() || undefined : raw;
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  @IsValidProposedSuggestionValue()
  proposedValue?: string;
}

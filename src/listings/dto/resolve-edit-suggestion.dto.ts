import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body of `PATCH /admin/listings/edit-suggestions/:id` — the moderator/admin
 * accept-or-dismiss decision on a member's proposed listing correction.
 */
export class ResolveEditSuggestionDto {
  @IsIn(['accepted', 'dismissed'])
  status!: 'accepted' | 'dismissed';

  /**
   * OPTIONAL moderator override for the value written to the listing on accept.
   *
   * Precedence, highest first: this value, then the suggester's
   * `proposedValue`, then the free-text `message`. A moderator who agrees with
   * the member's typed proposal accepts with nothing else in the body and the
   * proposal is written as it stands; one who wants to correct or reformat it
   * sends the value they want instead.
   *
   * Only meaningful with `status: 'accepted'`, and only for a suggestion whose
   * `field` maps to a writable listing column. Both other cases are rejected
   * with a 400 by `ListingEditSuggestionsService.resolve` rather than silently
   * ignored, since a moderator who typed a value and saw nothing happen has no
   * way to tell the difference between "applied" and "discarded".
   *
   * Not validated against the target column here: which column it lands on
   * depends on the stored suggestion row, which the DTO cannot see. `resolve`
   * runs it through the same `accepted-suggestion-value.ts` rules the create
   * path uses and answers with a 400 naming the failed constraint.
   */
  @IsOptional()
  @Transform((params: TransformFnParams) => {
    const raw: unknown = params.value;
    return typeof raw === 'string' ? raw.trim() || undefined : raw;
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  value?: string;
}

import { IsDateString, Matches, ValidateIf } from 'class-validator';

/**
 * `PATCH /magazine/admin/issues/:number/closes-on` body: the day the issue
 * stops taking copy.
 *
 * Mirrors `UpdateSubmissionDeadlineDto` exactly, for the same reason: `null`
 * is a meaningful value here, since clearing the close date is how an editor
 * takes the countdown back off the desk header. `@ValidateIf` skips the
 * format checks for exactly that case, so a present-but-null body passes
 * while a missing key still fails.
 */
export class UpdateIssueClosesOnDto {
  /** `YYYY-MM-DD`, or `null` to clear the close date. Both format decorators
   *  are needed: `@Matches` pins the date-only shape the `date` column stores
   *  (rejecting a full datetime), `@IsDateString` rejects a well-shaped but
   *  impossible date like "2026-13-45". */
  @ValidateIf((_object, value) => value !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'closesOn must be a YYYY-MM-DD date or null',
  })
  @IsDateString()
  closesOn!: string | null;
}

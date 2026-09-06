import { IsDateString, Matches, ValidateIf } from 'class-validator';

/**
 * `PATCH /magazine/admin/issues/:number/submission-deadline` body (PRD-106):
 * the last day the desk accepts pitches for this issue.
 *
 * Mirrors `UpdateIssueScheduleDto` exactly, for the same reason: `null` is a
 * meaningful value here rather than an omission, since clearing the deadline
 * is how an editor takes the line back off the public submit-story form.
 * `@ValidateIf` skips the format checks for exactly that case, so a
 * present-but-null body passes while a missing key still fails.
 */
export class UpdateSubmissionDeadlineDto {
  /** `YYYY-MM-DD`, or `null` to clear the deadline. Both format decorators are
   *  needed: `@Matches` pins the date-only shape the `date` column stores
   *  (rejecting a full datetime), `@IsDateString` rejects a well-shaped but
   *  impossible date like "2026-13-45". */
  @ValidateIf((_object, value) => value !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'submissionDeadline must be a YYYY-MM-DD date or null',
  })
  @IsDateString()
  submissionDeadline!: string | null;
}

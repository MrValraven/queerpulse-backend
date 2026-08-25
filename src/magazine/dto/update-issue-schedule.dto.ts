import { IsDateString, Matches, ValidateIf } from 'class-validator';

/**
 * `PATCH /magazine/admin/issues/:number/schedule` body: the issue's publish
 * date, set after the fact. The date is optional at creation (an editor opens
 * a number long before knowing when it runs), so this is how it gets filled
 * in later, moved, or cleared again.
 *
 * `null` is a meaningful value here, not an omission: it un-schedules the
 * issue. `@ValidateIf` skips the format checks for exactly that case, so a
 * present-but-null body passes while a missing key still fails
 * (`publishedOn` has no `@IsOptional()`).
 */
export class UpdateIssueScheduleDto {
  /** `YYYY-MM-DD`, or `null` to clear the date. Both format decorators are
   *  needed: `@Matches` pins the date-only shape the `date` column stores
   *  (rejecting a full datetime), `@IsDateString` rejects a well-shaped but
   *  impossible date like "2026-13-45". */
  @ValidateIf((_object, value) => value !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'publishedOn must be a YYYY-MM-DD date or null',
  })
  @IsDateString()
  publishedOn!: string | null;
}

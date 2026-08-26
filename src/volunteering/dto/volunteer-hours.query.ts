import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

/**
 * `GET /admin/volunteering/hours` — the window and optional community scope of
 * the funder report.
 *
 * Every field is optional: omitting both dates reports over all time, which is
 * the answer to "how many volunteer hours has QueerPulse contributed" with no
 * qualifier. The controller does the two checks class-validator cannot express
 * on its own: `from` must not be after `to`, and an explicitly bounded window
 * has a ceiling (`MAX_HOURS_WINDOW_DAYS`) so a typo'd year cannot ask the
 * database for a scan nobody wanted.
 *
 * `to` is EXCLUSIVE, matching `VolunteeringService.volunteerHoursTotals`
 * (`completed_at < :to`). The admin page sends period presets rather than a
 * hand-typed end date, so the boundary never has to be reasoned about on
 * screen.
 */
export class VolunteerHoursQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  /** Narrows the whole report to one community's opportunities. The
   *  per-community breakdown then has at most one row, which is the point:
   *  it is how a community answers for its own contribution. */
  @IsOptional()
  @IsUUID()
  communityId?: string;
}

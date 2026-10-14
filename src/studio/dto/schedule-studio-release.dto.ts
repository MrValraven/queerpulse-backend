import { IsISO8601, IsString, Matches } from 'class-validator';

/**
 * Studio v3 `POST /studio/releases/:id/schedule`. An ISO 8601 time with an
 * explicit offset, so the server never guesses a zone; the window is
 * checked against the server clock in `StudioSchedulingService`.
 */
export class ScheduleStudioReleaseDto {
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/, {
    message: 'publishAt must carry a time zone offset',
  })
  publishAt!: string;
}

import { IsOptional, IsUUID } from 'class-validator';

/** `POST /admin/studio/tracks/:id/mark-explicit` (Studio safety). */
export class MarkStudioTrackExplicitDto {
  /** The open `studio_track` report this action answers, if any. */
  @IsOptional()
  @IsUUID()
  reportId?: string;
}

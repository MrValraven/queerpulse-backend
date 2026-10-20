import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import {
  STUDIO_CONTENT_WARNINGS_MAX,
  STUDIO_CONTENT_WARNING_IDS,
  StudioContentWarningId,
} from '../studio-safety.constants';

/** `POST /admin/studio/tracks/:id/content-warnings` (Studio safety). Staff
 *  warnings only grow; there is no removal route. */
export class AddStudioTrackWarningsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STUDIO_CONTENT_WARNINGS_MAX)
  @IsIn(STUDIO_CONTENT_WARNING_IDS, { each: true })
  warnings!: StudioContentWarningId[];

  /** The open `studio_track` report this action answers, if any. */
  @IsOptional()
  @IsUUID()
  reportId?: string;
}

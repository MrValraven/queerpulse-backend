import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { STUDIO_VERSION_NOTE_MAX } from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

/** Studio v3 `POST /studio/releases/:id/versions`: what changed, 1 to 280
 *  characters after trimming. */
export class CreateStudioReleaseVersionDto {
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_VERSION_NOTE_MAX)
  note!: string;
}

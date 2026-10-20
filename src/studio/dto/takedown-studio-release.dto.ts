import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

export class TakedownStudioReleaseDto {
  /** Shown to the release's owners beside the taken-down release. */
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.takedownReasonMaxLength)
  reason!: string;

  /**
   * Studio open demo pages: the open `studio_release` report this takedown
   * was started from. It must be about this release, or the takedown is
   * refused. Every open report about the release is resolved either way.
   * Or (Studio safety) a `studio_track` report about one of the release's tracks.
   */
  @IsOptional()
  @IsUUID()
  reportId?: string;
}

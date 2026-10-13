import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

export class TakedownStudioReleaseDto {
  /** Shown to the release's owners beside the taken-down release. */
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.takedownReasonMaxLength)
  reason!: string;
}

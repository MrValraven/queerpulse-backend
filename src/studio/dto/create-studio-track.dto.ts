import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

export class CreateStudioTrackDto {
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.trackTitleMaxLength)
  title!: string;
}

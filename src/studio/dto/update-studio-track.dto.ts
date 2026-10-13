import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';
import { isPresentValue, trimStringValue } from './create-studio-release.dto';

export class StudioCreditDto {
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.creditFieldMaxLength)
  name!: string;

  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.creditFieldMaxLength)
  role!: string;
}

// PATCH semantics, as in `UpdateStudioReleaseDto`. `credits` replaces the
// whole ordered list. Lyrics keep their own whitespace (line breaks matter).
export class UpdateStudioTrackDto {
  @ValidateIf(isPresentValue)
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.trackTitleMaxLength)
  title?: string;

  @ValidateIf(isPresentValue)
  @IsArray()
  @ArrayMaxSize(STUDIO_LIMITS.creditsMaxRows)
  @ValidateNested({ each: true })
  @Type(() => StudioCreditDto)
  credits?: StudioCreditDto[];

  @IsOptional()
  @IsString()
  @MaxLength(STUDIO_LIMITS.lyricsMaxLength)
  lyrics?: string | null;

  @ValidateIf(isPresentValue)
  @IsBoolean()
  isExplicit?: boolean;
}

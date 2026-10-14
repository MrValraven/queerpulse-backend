import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsSafeUrl } from '../../common/validators/is-safe-url.decorator';
import { STUDIO_PRESS } from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

/** Validate whenever the key is anything but null, so a missing key fails
 *  the type check and null clears. */
const isNotNull = (_body: object, value: unknown): boolean => value !== null;

/** Contact skips validation when null or empty after trimming; both store null. */
const isNotNullOrEmpty = (_body: object, value: unknown): boolean =>
  value !== null && value !== '';

export class StudioPressQuoteDto {
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_PRESS.quoteMax)
  quote!: string;

  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_PRESS.sourceMax)
  source!: string;
}

/**
 * Studio v3 `PUT /studio/artists/:subprofileId/press-kit`. Every key is
 * required; `null` or `[]` clears. An empty string is stored as null.
 */
export class UpdateStudioPressKitDto {
  @ValidateIf(isNotNull)
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_PRESS.pitchMax)
  pitch!: string | null;

  @ValidateIf(isNotNull)
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_PRESS.bioMax)
  pressBio!: string | null;

  @IsArray()
  @ArrayMaxSize(STUDIO_PRESS.featuredMax)
  @ArrayUnique((trackId: unknown) =>
    typeof trackId === 'string' ? trackId.toLowerCase() : trackId,
  )
  @IsUUID('all', { each: true })
  featuredTrackIds!: string[];

  @IsArray()
  @ArrayMaxSize(STUDIO_PRESS.quotesMax)
  @ValidateNested({ each: true })
  @Type(() => StudioPressQuoteDto)
  quotes!: StudioPressQuoteDto[];

  // `https://` or `mailto:`, the persona contact rule.
  @ValidateIf(isNotNullOrEmpty)
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_PRESS.contactMax)
  @IsSafeUrl()
  contact!: string | null;
}

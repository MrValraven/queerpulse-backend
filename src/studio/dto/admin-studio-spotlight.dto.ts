import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { STUDIO_DISCOVERY_LIMITS } from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

/** `PUT artist-of-the-month` and `POST new-stars`: the persona to place. */
export class PlaceAdminStudioSpotlightArtistDto {
  @IsUUID()
  subprofileId!: string;

  /** Trimmed; the service stores an empty note as null. */
  @IsOptional()
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_DISCOVERY_LIMITS.curationNoteMaxLength)
  note?: string | null;
}

/** `PATCH :id`. */
export class UpdateAdminStudioSpotlightArtistDto {
  /** Required; null clears the note. */
  @ValidateIf((_body: object, value: unknown) => value !== null)
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_DISCOVERY_LIMITS.curationNoteMaxLength)
  note!: string | null;
}

export class ReorderAdminStudioNewStarsDto {
  /** Every New stars row exactly once, in the new order. */
  @IsArray()
  @ArrayMaxSize(STUDIO_DISCOVERY_LIMITS.spotlightNewStarsMax)
  @IsUUID('all', { each: true })
  spotlightIds!: string[];
}

/** `GET /admin/studio/spotlight/artist-search?q=`. It has its own class
 *  because `AdminStudioSearchQuery` belongs to another session. */
export class AdminStudioSpotlightArtistSearchQuery {
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_DISCOVERY_LIMITS.adminSearchQueryMaxLength)
  q!: string;
}

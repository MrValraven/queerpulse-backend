import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  STUDIO_CURATION_SHELVES,
  STUDIO_DISCOVERY_LIMITS,
  StudioCurationShelf,
} from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

export class CreateAdminStudioPickDto {
  @IsIn(STUDIO_CURATION_SHELVES)
  shelf!: StudioCurationShelf;

  @IsUUID()
  releaseId!: string;

  /** Trimmed; the service stores an empty note as null. */
  @IsOptional()
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_DISCOVERY_LIMITS.curationNoteMaxLength)
  note?: string | null;
}

export class UpdateAdminStudioPickDto {
  /** Required; null clears the note. */
  @ValidateIf((_body: object, value: unknown) => value !== null)
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_DISCOVERY_LIMITS.curationNoteMaxLength)
  note!: string | null;
}

export class ReorderAdminStudioPicksDto {
  /** Every pick of the shelf exactly once, in the new order. */
  @IsArray()
  @ArrayMaxSize(STUDIO_DISCOVERY_LIMITS.curationShelfMax)
  @IsUUID('all', { each: true })
  pickIds!: string[];
}

export class AdminStudioShelfParams {
  @IsIn(STUDIO_CURATION_SHELVES)
  shelf!: StudioCurationShelf;
}

/** `q` for the admin event, track and persona searches. */
export class AdminStudioSearchQuery {
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_DISCOVERY_LIMITS.adminSearchQueryMaxLength)
  q!: string;
}

/** `GET /admin/studio/curation/release-search?q=`. An empty or missing `q`
 *  lists the newest published releases. */
export class AdminStudioReleaseSearchQuery {
  @IsOptional()
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_DISCOVERY_LIMITS.adminSearchQueryMaxLength)
  q?: string;
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CREATOR_DRAFT_LIMITS } from '../creator-drafts.constants';

/** The `revision` column is a Postgres int; a larger base answers 400. */
const POSTGRES_INT_MAX = 2_147_483_647;

/** The creator's own wizard state, stored as sent. `done` above `total`
 *  answers 400 in the service, which sees both numbers together. */
export class CreatorDraftProgressDto {
  @IsInt()
  @Min(0)
  @Max(CREATOR_DRAFT_LIMITS.progressTotalMax)
  done!: number;

  @IsInt()
  @Min(1)
  @Max(CREATOR_DRAFT_LIMITS.progressTotalMax)
  total!: number;
}

/**
 * One autosave of a creator draft. Every key is required and null is the only
 * empty value, so an omitted key fails validation. The payload is opaque to
 * the server (owned by the frontend), so its keys pass through untouched.
 */
export class SaveCreatorDraftDto {
  @IsObject()
  payload!: Record<string, unknown>;

  @IsInt()
  @Min(1)
  @Max(CREATOR_DRAFT_LIMITS.payloadVersionMax)
  payloadVersion!: number;

  /** The revision the caller read; null only for the first save of an empty
   *  (or expired) slot. */
  @ValidateIf((body: SaveCreatorDraftDto) => body.baseRevision !== null)
  @IsInt()
  @Min(1)
  @Max(POSTGRES_INT_MAX)
  baseRevision!: number | null;

  @ValidateIf((body: SaveCreatorDraftDto) => body.progress !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => CreatorDraftProgressDto)
  progress!: CreatorDraftProgressDto | null;

  /** Codes the editor still flags as unfinished, any string up to 64
   *  characters (the listing editor sends camelCase field keys). */
  @ValidateIf((body: SaveCreatorDraftDto) => body.missing !== null)
  @IsArray()
  @ArrayMaxSize(CREATOR_DRAFT_LIMITS.missingCodesMax)
  @IsString({ each: true })
  @MaxLength(CREATOR_DRAFT_LIMITS.missingCodeMaxLength, { each: true })
  missing!: string[] | null;
}

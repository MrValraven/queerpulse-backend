import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ListingStatus } from '../entities/listing.entity';

/** `PATCH /admin/listings/bulk-status` body (moderator/admin only) — applies
 * one status transition to many listings in a single transaction (item #9).
 * `reason` is optional free text recorded on each listing's moderation event
 * and included in the best-effort DM to each submitter (item #15). */
export class BulkStatusDto {
  @IsArray()
  @ArrayNotEmpty()
  // Caps the batch so one request can't open an unbounded-length transaction
  // (mirrors `BulkItemsDto.ids` in `src/roadmap/dto/bulk-items.dto.ts`) —
  // comfortably above any real moderation-queue multi-select.
  @ArrayMaxSize(200)
  @IsString({ each: true })
  refs!: string[];

  @IsEnum(ListingStatus)
  status!: ListingStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

/** `POST /admin/listings/bulk-remove` body (moderator/admin only) — hard
 * deletes many listings in a single transaction (item #9). */
export class BulkRemoveDto {
  @IsArray()
  @ArrayNotEmpty()
  // Same cap/rationale as `BulkStatusDto.refs` above.
  @ArrayMaxSize(200)
  @IsString({ each: true })
  refs!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

/**
 * Response shape for both bulk endpoints — which refs succeeded and which
 * didn't. An unknown ref is the only per-item failure mode (added to
 * `failed` without aborting the rest of the batch); a genuine DB error
 * instead propagates and rolls back the whole transaction (a 500 for the
 * request). Not a class-validator DTO (nothing to validate on a response) —
 * kept alongside the request DTOs above since both describe the same
 * bulk-action surface.
 */
export interface BulkListingResultDTO {
  updated: string[];
  failed: string[];
}

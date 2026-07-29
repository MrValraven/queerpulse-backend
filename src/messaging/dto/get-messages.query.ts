import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class GetMessagesQuery {
  // `before`/`beforeId` form a composite keyset cursor: the created_at and id of
  // the oldest message the client currently holds. Pass both to page older
  // without skipping same-millisecond ties; `before` alone keeps legacy
  // behaviour.
  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @IsUUID('4')
  beforeId?: string;

  // `after`/`afterId` are the forward counterpart of `before`/`beforeId`: the
  // created_at and id of the NEWEST message the client currently holds. Used by
  // reconnect history sync to fetch (oldest→newest) everything missed while the
  // socket was down. Mutually exclusive with the backward cursor.
  @IsOptional()
  @IsISO8601()
  after?: string;

  @IsOptional()
  @IsUUID('4')
  afterId?: string;

  // Opaque cursor (see `src/common/cursor-pagination.ts`) the frontend sends
  // instead of `before`/`beforeId`. Decoded server-side into the same
  // (createdAt, id) keyset predicate; ignored (falls back to the first page)
  // when it doesn't decode, and superseded by an explicit `before` if both
  // are present.
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

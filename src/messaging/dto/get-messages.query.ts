import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

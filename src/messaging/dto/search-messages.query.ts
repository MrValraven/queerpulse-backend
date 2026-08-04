import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Query for `GET /messages/search`. `q` is the free-text term matched against
 * message bodies (case-insensitive substring, server-side). Bounded at both ends
 * — a 1-char floor keeps the result set meaningful, a 200-char ceiling caps the
 * `ILIKE` pattern length — and `limit` clamps the page the service returns.
 */
export class SearchMessagesQuery {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

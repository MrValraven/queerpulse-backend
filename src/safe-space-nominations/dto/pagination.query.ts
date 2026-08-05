import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

// Bounds the admin nominations list so a caller pages through the queue instead
// of pulling every row; `limit` is capped to keep a page from being unbounded.
export class PaginationQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

// `GET /admin/forum/review?cursor=&limit=` query — the same cursor/limit pair
// `ListThreadsQuery` carries, and the same ceiling, because it pages the same
// table through the same `cursorPaginate` keyset.
export class ListReviewQueueQuery {
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

import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

// `GET /forum/threads?category=&cursor=&sort=&tag=&q=` query.
export class ListThreadsQuery {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // Ordering of the page. `new` (default) → newest-first by `(createdAt, id)`;
  // `top` → highest OP vote count; `active` → most-recently-active; `unanswered`
  // → newest-first among threads with no replies. The service applies the sort
  // (Wave 2); validated here so an unknown value is rejected up front.
  @IsOptional()
  @IsIn(['new', 'top', 'active', 'unanswered'])
  sort?: 'new' | 'top' | 'active' | 'unanswered';

  // Single tag filter — matched against the thread's normalized `tags` array.
  @IsOptional()
  @IsString()
  tag?: string;

  // Free-text search over the thread title (ILIKE), folded into the list query.
  @IsOptional()
  @IsString()
  q?: string;
}

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

  // Ordering of the page. `active` (the DEFAULT when omitted) →
  // most-recently-active; `new` → newest-first by `(createdAt, id)`; `top` →
  // highest OP vote count among threads from the last 30 days, tie-broken by
  // recency, falling back to the whole forum when the window is near-empty;
  // `unanswered` → newest-first among threads with no accepted answer. The
  // service applies the sort; validated here so an unknown value is rejected up
  // front.
  @IsOptional()
  @IsIn(['new', 'top', 'active', 'unanswered'])
  sort?: 'new' | 'top' | 'active' | 'unanswered';

  // Single tag filter — matched against the thread's normalized `tags` array.
  @IsOptional()
  @IsString()
  tag?: string;

  // Free-text search (ILIKE) over the thread title OR the body of any visible
  // post in the thread, folded into the list query. See
  // `ForumThreadsService.applyTextAndTagFilters`.
  @IsOptional()
  @IsString()
  q?: string;
}

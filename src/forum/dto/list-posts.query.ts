import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { REPLY_SORTS, ReplySort } from '../forum-reply-sort';

// `GET /forum/threads/:slug/posts?cursor=&limit=&sort=` query.
export class ListPostsQuery {
  @IsOptional()
  @IsString()
  cursor?: string;

  // Counts TOP-LEVEL replies, not posts: a page carries `limit` roots plus
  // everything nested under them, so a reply never arrives before its parent
  // (see `ForumPostsService.listPosts`).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // Ordering of the replies (C6/PRD-162). `oldest` (the DEFAULT when omitted,
  // and the endpoint's long-standing behaviour) → chronological; `newest` →
  // `created_at DESC`; `top` → `vote_count DESC` with the oldest reply as the
  // tie-break. The accepted answer keeps its pinned-to-top treatment in all
  // three. Each sort mints its own cursor, so a client changing the sort must
  // drop the cursor it holds. Validated here so an unknown value is rejected up
  // front.
  @IsOptional()
  @IsIn(REPLY_SORTS)
  sort?: ReplySort;
}

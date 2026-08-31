import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

/**
 * `GET /communities/:slug/join-requests?page=` query (ENG-41).
 *
 * The pending-join-request queue used to answer with a flat array capped at
 * `DEFAULT_LIST_LIMIT`, which meant a community with more pending requests than
 * the cap hid the overflow from every moderator with nothing in the response
 * saying so. It now answers with the repo's `Paginated<T>` envelope, so `total`
 * states the size of the whole queue and this `page` is how a moderator walks
 * past the first page to reach the rest of it.
 *
 * Shape copied from `ListCommunitiesQuery.page`, including the `@Max(MAX_PAGE)`
 * cap that stops `?page=2000000000` from becoming a deep-offset scan (ENG-49).
 */
export class ListJoinRequestsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}

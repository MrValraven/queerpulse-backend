import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { JoinRequestStatus } from '../entities/coop-join-request.entity';

/**
 * `GET /admin/housing/join-requests?page&status&coop` query (ENG-41).
 *
 * This is the fourth and last of the moderation queues the finding covers, and
 * it carried both of the defects the other three did. It answered with a flat
 * array of the newest `DEFAULT_LIST_LIMIT` requests in EVERY status, and the
 * admin console then filtered client-side to the pending ones. So a platform
 * with 200 already-decided requests newer than one pending request hid that
 * pending request from every admin, and the queue could read as empty while
 * somebody waited on an answer. The response is now a
 * `{ items, total, page, pageSize }` page, and `status` moves the filter into
 * the query where it can also be counted.
 *
 * `status` is optional, and omitting it still returns every status, so the
 * pre-existing "one slab of everything" read is unchanged for any caller that
 * wants it. The console asks for `status=pending`.
 *
 * Mirrors `ListGroupJoinRequestsQuery` in the sibling housing-groups module
 * field for field, including the `@Max(MAX_PAGE)` deep-offset cap from ENG-49.
 */
export class ListCoopJoinRequestsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  // `?status=pending` is "what still needs a decision", which is the only thing
  // the console has ever rendered. Omitted means every state.
  @IsOptional()
  @IsEnum(JoinRequestStatus)
  status?: JoinRequestStatus;

  // The co-op slug to narrow to. Named `coop` because that is the parameter
  // name the route already accepted before it took a DTO, so every existing
  // caller keeps working unchanged.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  coop?: string;
}

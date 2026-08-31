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
import { GroupJoinRequestStatus } from '../entities/group-join-request.entity';

/**
 * `GET /admin/housing-groups/join-requests?page&status&group` query (ENG-41).
 *
 * This queue was the worst of the three the finding covers. It answered with a
 * flat array of the NEWEST `DEFAULT_LIST_LIMIT` requests in EVERY status, and
 * the console then filtered client-side to the pending ones. So a group with 200
 * already-decided requests newer than a pending one hid that pending request
 * from every moderator, and the queue could read as empty while people waited.
 * The response is now a `{ items, total, page, pageSize }` page, and `status`
 * moves the filter into the query where it can be counted.
 *
 * `status` is optional, and omitting it still returns every status, so the
 * pre-existing "one slab of everything" read is unchanged for any caller that
 * wants it. The console asks for `status=pending`.
 *
 * The `page` shape (including the `@Max(MAX_PAGE)` deep-offset cap from ENG-49)
 * is copied from this module's own `ListGroupListingQueueQuery`.
 */
export class ListGroupJoinRequestsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  // `?status=pending` is "what still needs a decision", which is the only thing
  // the console has ever rendered. Omitted means every state.
  @IsOptional()
  @IsEnum(GroupJoinRequestStatus)
  status?: GroupJoinRequestStatus;

  // The group slug to narrow to. Named `group` because that is the parameter
  // name the route already accepted before it took a DTO.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  group?: string;
}

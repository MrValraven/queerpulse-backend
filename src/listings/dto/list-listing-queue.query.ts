import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { ListingStatus } from '../entities/listing.entity';

const LISTING_QUEUE_SORTS = ['newest', 'oldest', 'name'] as const;
export type ListingQueueSort = (typeof LISTING_QUEUE_SORTS)[number];

/** `GET /admin/listings/queue?status=&page=&q=&sort=` query. Moderator/admin-only
 * (see `ListingsController.listQueue`). `status` omitted ⇒ every status;
 * `q` (item #9) searches the listing name, submitter first name, and ref;
 * `sort` omitted ⇒ `newest` (matches the queue's historical default order). */
export class ListListingQueueQuery {
  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  // Interpolated into three `ILIKE '%...%'` patterns (`listings.service.ts`),
  // so an unbounded term is a cheap way to make Postgres scan hard. 120 matches
  // the cap `SearchQuery.q` already uses.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsIn(LISTING_QUEUE_SORTS)
  sort?: ListingQueueSort;
}

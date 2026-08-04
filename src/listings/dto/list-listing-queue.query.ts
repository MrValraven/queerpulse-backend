import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ListingStatus } from '../entities/listing.entity';

const LISTING_QUEUE_SORTS = ['newest', 'oldest', 'name'] as const;
export type ListingQueueSort = (typeof LISTING_QUEUE_SORTS)[number];

/** `GET /listings/admin/queue?status=&page=&q=&sort=` query. Moderator/admin-only
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
  page?: number;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(LISTING_QUEUE_SORTS)
  sort?: ListingQueueSort;
}

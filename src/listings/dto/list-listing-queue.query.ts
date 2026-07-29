import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { ListingStatus } from '../entities/listing.entity';

/** `GET /listings/admin/queue?status=&page=` query. Moderator/admin-only
 * (see `ListingsController.listQueue`). `status` omitted ⇒ every status. */
export class ListListingQueueQuery {
  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

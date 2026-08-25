import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/** `GET /listings/:ref/history?page=` query (C3). Mirrors
 * `ListMyListingsQuery`'s shape exactly (page-number offset pagination, the
 * convention every listing list endpoint follows). */
export class ListOwnerListingHistoryQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

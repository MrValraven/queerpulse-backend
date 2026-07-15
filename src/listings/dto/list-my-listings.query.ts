import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/** `GET /listings/mine?page=` query — mirrors `ListPartnersQuery`'s shape. */
export class ListMyListingsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

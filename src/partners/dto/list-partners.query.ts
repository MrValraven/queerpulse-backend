import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { PartnerRegion } from '../entities/partner.entity';

export class ListPartnersQuery {
  // Filters `Partner.region`.
  @IsOptional() @IsEnum(PartnerRegion) region?: PartnerRegion;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

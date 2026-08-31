import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { PartnerRegion } from '../entities/partner.entity';

export class ListPartnersQuery {
  // Filters `Partner.region`.
  @IsOptional() @IsEnum(PartnerRegion) region?: PartnerRegion;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  // `?featured=true` restricts the listing to featured partners (the For
  // Organisations proof rail). Coerces the query-string "true"/"false".
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  featured?: boolean;
}

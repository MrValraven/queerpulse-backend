import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { OrgTierCtaType } from '../entities/org-tier.entity';

export class CreateOrgTierDto {
  @IsString() @MaxLength(120) name: string;
  @IsString() @MaxLength(40) priceDisplay: string;
  @IsString() @MaxLength(60) pricePeriod: string;
  @IsString() @MaxLength(400) dek: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  bullets?: string[];

  @IsString() @MaxLength(400) footnote: string;
  @IsEnum(OrgTierCtaType) ctaType: OrgTierCtaType;
  @IsString() @MaxLength(80) ctaLabel: string;

  @IsOptional() @IsString() @MaxLength(200) ctaTarget?: string | null;
  @IsOptional() @IsBoolean() featured?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() published?: boolean;
  /** Desired slug source; defaults to `name`. */
  @IsOptional() @IsString() handle?: string;
}

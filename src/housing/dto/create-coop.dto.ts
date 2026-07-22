import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { CoopCtaKind, HousingPhase } from '../entities/housing-coop.entity';
import { FaceDto } from './face.dto';

export class CreateCoopDto {
  @IsString()
  @Matches(/^[a-z0-9-]+$/)
  slug: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  nameEm?: string;

  @IsString()
  city: string;

  @IsString()
  area: string;

  @IsInt()
  @Min(0)
  householdCount: number;

  @IsEnum(HousingPhase)
  phase: HousingPhase;

  @IsInt()
  @Min(0)
  @Max(100)
  progress: number;

  @IsOptional()
  @IsBoolean()
  operational?: boolean;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  operationalSince?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  formingSince?: string;

  @IsString()
  description: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  shareAmountEuros?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyEuros?: number;

  @IsOptional()
  @IsBoolean()
  sharesAreTarget?: boolean;

  @IsEnum(CoopCtaKind)
  ctaKind: CoopCtaKind;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FaceDto)
  faces?: FaceDto[];

  @IsOptional()
  @IsBoolean()
  published?: boolean;
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CoopCtaKind, HousingPhase } from '../entities/housing-coop.entity';
import { FaceDto } from './face.dto';

export class CreateCoopDto {
  @IsString()
  @Matches(/^[a-z0-9-]+$/)
  @MaxLength(120)
  slug!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEm?: string;

  @IsString()
  @MaxLength(120)
  city!: string;

  @IsString()
  @MaxLength(120)
  area!: string;

  @IsInt()
  @Min(0)
  householdCount!: number;

  @IsEnum(HousingPhase)
  phase!: HousingPhase;

  @IsInt()
  @Min(0)
  @Max(100)
  progress!: number;

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
  @MaxLength(5000)
  description!: string;

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
  ctaKind!: CoopCtaKind;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => FaceDto)
  faces?: FaceDto[];

  @IsOptional()
  @IsBoolean()
  published?: boolean;

  // Operator-identity-verified marker — admin/steward-set (see entity).
  @IsOptional()
  @IsBoolean()
  operatorVerified?: boolean;
}

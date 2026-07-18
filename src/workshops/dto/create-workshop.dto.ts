import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { WorkshopHeroTint, WorkshopMode } from '../entities/workshop.entity';

export class WorkshopTierDto {
  @IsString() @MinLength(1) @MaxLength(120) label: string;

  // Numeric, not the frontend's formatted "€180" — the client formats it.
  @IsNumber() @Min(0) amount: number;

  @IsOptional() @IsBoolean() sliding?: boolean;
}

export class WorkshopSessionDto {
  @IsString() @MinLength(1) @MaxLength(10) n: string;
  @IsString() @MinLength(1) @MaxLength(200) title: string;
  @IsString() @MaxLength(1000) desc: string;
  @IsString() @MaxLength(100) date: string;
  @IsString() @MaxLength(50) length: string;
  @IsOptional() @IsBoolean() done?: boolean;
}

export class WorkshopNeedDto {
  @IsString() @MinLength(1) @MaxLength(120) label: string;
  @IsString() @MaxLength(1000) detail: string;
  @IsOptional() @IsBoolean() included?: boolean;
  @IsOptional() @IsString() @MaxLength(60) tag?: string;
}

export class WorkshopLocationDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(500) access?: string;
}

export class CreateWorkshopDto {
  @IsString() @MinLength(3) @MaxLength(200) title: string;

  // Optional: `buildWorkshop` leaves it empty for member-added workshops.
  @IsOptional() @IsString() @MaxLength(200) titleEm?: string;

  // The modal gates on `blurb.trim().length > 8` / `about.trim().length > 12`;
  // `MinLength` here mirrors those thresholds server-side.
  @IsString() @MinLength(9) @MaxLength(2000) blurb: string;

  @IsString() @MinLength(1) @MaxLength(100) cat: string;

  @IsEnum(WorkshopMode) mode: WorkshopMode;

  // Clamps mirror `buildWorkshop`'s `Math.max(1, Math.min(52, ...))` and
  // `Math.max(2, Math.min(40, ...))`, plus the modal's `min`/`max` attributes.
  @Type(() => Number) @IsInt() @Min(1) @Max(52) weeks: number;
  @Type(() => Number) @IsInt() @Min(2) @Max(40) spotsTotal: number;

  @IsNumber() @Min(0) price: number;

  @IsOptional() @IsString() @MaxLength(10) currency?: string;

  @IsOptional() @IsString() @MaxLength(200) priceSub?: string;
  @IsOptional() @IsString() @MaxLength(100) startDate?: string;
  @IsOptional() @IsString() @MaxLength(200) cancellation?: string;

  @IsOptional() @IsString() @MaxLength(200) heroPlaceholder?: string;
  @IsOptional() @IsEnum(WorkshopHeroTint) heroTint?: WorkshopHeroTint;

  @IsOptional() @IsString() @MaxLength(200) hostRole?: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(5000, { each: true })
  about: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => WorkshopTierDto)
  tiers?: WorkshopTierDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(52)
  @ValidateNested({ each: true })
  @Type(() => WorkshopSessionDto)
  sessions?: WorkshopSessionDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => WorkshopNeedDto)
  needs?: WorkshopNeedDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  pastWork?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  tags?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => WorkshopLocationDto)
  location?: WorkshopLocationDto;
}

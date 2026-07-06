import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CompanyValueDto {
  @IsString() @MinLength(1) @MaxLength(80) title: string;
  @IsString() @MinLength(1) @MaxLength(500) desc: string;
}

export class CompanyInfoItemDto {
  @IsString() @MinLength(1) @MaxLength(80) label: string;
  @IsString() @MinLength(1) @MaxLength(300) value: string;
}

export class CompanyWorkItemDto {
  @IsString() @MinLength(1) @MaxLength(200) label: string;
  @IsOptional() @IsString() @MaxLength(500) imageUrl?: string;
}

export class HiringContactDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsString() @MinLength(1) @MaxLength(200) role: string;
}

export class CreateCompanyDto {
  @IsString() @MinLength(1) @MaxLength(200) nameText: string;
  @IsString() @MinLength(1) @MaxLength(200) tagline: string;
  @IsString() @MinLength(1) @MaxLength(10000) about: string;

  // `verified` is intentionally not a field here at all — it's admin-only
  // and `CompaniesService.create` always forces it `false` regardless of
  // what's sent (there's nothing a member-facing DTO could set).
  @IsOptional() @IsBoolean() queerRun?: boolean;
  @IsOptional() @IsBoolean() queerLed?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CompanyValueDto)
  values?: CompanyValueDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CompanyInfoItemDto)
  info?: CompanyInfoItemDto[];

  // Member slugs -> resolved + seeded as `company_team_members` rows on
  // creation (see `CompaniesService.resolveTeamUserIds`).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  team?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => HiringContactDto)
  hiringContact?: HiringContactDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CompanyWorkItemDto)
  work?: CompanyWorkItemDto[];

  // Desired slug; `CompaniesService.createWithUniqueSlug` slugifies +
  // de-dupes it, defaulting to `nameText` when omitted. Ignored entirely on
  // PATCH (see `UpdateCompanyDto`).
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) handle?: string;
}

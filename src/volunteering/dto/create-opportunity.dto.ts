import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  OpportunityCause,
  OpportunityCommitLevel,
} from '../entities/volunteer-opportunity.entity';

export class OpportunityTaskDto {
  @IsString() @MinLength(1) @MaxLength(200) title: string;
  @IsString() @MinLength(1) @MaxLength(2000) desc: string;
}

export class OpportunityCommitmentDto {
  @IsString() @MinLength(1) @MaxLength(200) label: string;
  @IsString() @MinLength(1) @MaxLength(2000) detail: string;
}

export class CreateOpportunityDto {
  @IsString() @MinLength(1) @MaxLength(200) org: string;

  // Existing partner org slug — resolved to `partner_id` via
  // `PartnersService.idBySlug` (see `VolunteeringService.create`/`update`).
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) partnerSlug?: string;

  @IsString() @MinLength(1) @MaxLength(200) role: string;
  @IsEnum(OpportunityCause) cause: OpportunityCause;
  @IsEnum(OpportunityCommitLevel) commit: OpportunityCommitLevel;

  // Display-only commitment string (e.g. "2 hrs / week").
  @IsString() @MinLength(1) @MaxLength(200) time: string;

  @IsString() @MinLength(1) @MaxLength(200) location: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  skills?: string[];

  @IsString() @MinLength(1) @MaxLength(10000) desc: string;

  @IsInt() @Min(1) spotsTotal: number;

  @IsString() @MinLength(1) @MaxLength(200) applyRole: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  why?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => OpportunityTaskDto)
  tasks?: OpportunityTaskDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => OpportunityCommitmentDto)
  commitments?: OpportunityCommitmentDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  goodFor?: string[];

  @IsOptional() @IsString() @MaxLength(2000) teamIntro?: string;

  // Member slugs -> resolved + seeded as `volunteer_opportunity_team` rows on
  // creation (see `VolunteeringService.resolveTeamUserIds`).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  team?: string[];

  // Desired slug; `VolunteeringService.createWithUniqueSlug` slugifies +
  // de-dupes it, defaulting to `role`+`org` when omitted. Ignored entirely on
  // PATCH (see `UpdateOpportunityDto`).
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) handle?: string;
}

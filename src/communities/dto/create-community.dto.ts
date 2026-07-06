import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AccessTier, CommunityType } from '../entities/community.entity';

/**
 * The only values a community's `features` array may contain (spec: Phase A
 * / Request DTOs). The `communities.features` column is a plain `text[]` —
 * no dedicated entity enum backs it — so the literal set lives here, next to
 * the one DTO field that validates against it.
 */
export const COMMUNITY_FEATURES = [
  'discussion',
  'events',
  'rooms',
  'roster',
  'library',
] as const;
export type CommunityFeature = (typeof COMMUNITY_FEATURES)[number];

export class CreateCommunityDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsString() @MinLength(1) @MaxLength(5000) purpose: string;
  @IsEnum(CommunityType) type: CommunityType;
  @IsString() @MinLength(1) @MaxLength(2000) whoFor: string;
  @IsEnum(AccessTier) accessTier: AccessTier;
  @IsBoolean() rosterVisible: boolean;

  @IsArray()
  @ArrayMaxSize(COMMUNITY_FEATURES.length)
  @IsIn(COMMUNITY_FEATURES, { each: true })
  features: string[];

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  rules: string[];

  @IsString() @MinLength(1) @MaxLength(200) tagline: string;

  // Desired slug; `CommunitiesService.createWithUniqueRef` slugifies +
  // de-dupes it. Ignored entirely on PATCH (see `UpdateCommunityDto`).
  @IsString() @MinLength(1) @MaxLength(100) handle: string;

  // Member slugs -> seeded as 'mod' roster rows on creation.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  stewards?: string[];

  // Member slugs -> resolved but not force-added (no consent-less roster
  // adds; see `CommunitiesService.seedExtraRoster`).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  invites?: string[];
}

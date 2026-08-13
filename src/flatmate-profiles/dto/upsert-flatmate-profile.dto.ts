import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  FlatmateProfileType,
  IdentityVisibility,
} from '../entities/flatmate-profile.entity';

/** Optional shared-living preferences + co-living questionnaire. Every key is
 * free-ish text and optional; ordinary (non-special-category) data. `noise` and
 * `sharing` are the P1.3 questionnaire additions. `outAtHome` moved out of here
 * into the consent-gated `IdentityHouseholdDto` (orientation-revealing). */
export class HouseholdNormsDto {
  @IsOptional() @IsString() @MaxLength(60) smoking?: string;
  @IsOptional() @IsString() @MaxLength(60) pets?: string;
  @IsOptional() @IsString() @MaxLength(60) guests?: string;
  @IsOptional() @IsString() @MaxLength(60) cleanliness?: string;
  @IsOptional() @IsString() @MaxLength(60) sleepSchedule?: string;
  @IsOptional() @IsString() @MaxLength(60) noise?: string;
  @IsOptional() @IsString() @MaxLength(60) sharing?: string;
}

/** Consent-gated (Art.9) trans-affirming household prompts. Only stored when
 * `specialCategoryConsent` is true; cleared on withdrawal. Health-adjacent
 * (medication) + identity-adjacent (out-at-home, name privacy). */
export class IdentityHouseholdDto {
  @IsOptional() @IsString() @MaxLength(60) outAtHome?: string;
  @IsOptional() @IsString() @MaxLength(80) bathroomComfort?: string;
  @IsOptional() @IsString() @MaxLength(80) mailNamePrivacy?: string;
  @IsOptional() @IsString() @MaxLength(80) medicationPrivacy?: string;
}

/** PUT /flatmate-profiles/mine body — the full desired state of my one profile
 * (create-or-replace). `type` + `budgetEuros` are required; the rest default.
 *
 * The special-category identity fields (`pronouns`, `genderIdentity`,
 * `safeSpaceNeeds`) are only stored when `specialCategoryConsent` is `true`.
 * Sending `false` (or omitting it) is a consent withdrawal: the service clears
 * those fields and the stored consent timestamp. */
export class UpsertFlatmateProfileDto {
  @IsEnum(FlatmateProfileType) type!: FlatmateProfileType;

  @IsOptional() @IsString() @MaxLength(60) pronouns?: string;

  @IsOptional() @IsString() @MaxLength(120) neighbourhood?: string;

  @IsInt() @Min(0) budgetEuros!: number;

  @IsOptional() @IsDateString() moveInFrom?: string;

  @IsOptional() @IsBoolean() flexibleTiming?: boolean;

  @IsOptional() @IsString() @MaxLength(2000) about?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  lifestyleTags?: string[];

  // ── GDPR Art.9 special-category identity (opt-in) ────────────────────────

  /** Explicit, purpose-scoped consent to store & show the special-category
   * fields. When absent/false the service clears them (withdrawal). */
  @IsOptional() @IsBoolean() specialCategoryConsent?: boolean;

  @IsOptional() @IsString() @MaxLength(120) genderIdentity?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  safeSpaceNeeds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => HouseholdNormsDto)
  householdNorms?: HouseholdNormsDto;

  /** Consent-gated trans-affirming household prompts. Only persisted when
   * `specialCategoryConsent` is true (same gate as pronouns/gender/needs). */
  @IsOptional()
  @ValidateNested()
  @Type(() => IdentityHouseholdDto)
  identityHousehold?: IdentityHouseholdDto;

  @IsOptional()
  @IsEnum(IdentityVisibility)
  identityVisibility?: IdentityVisibility;
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
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
  MAX_OPPORTUNITY_CAUSES,
  OpportunityCause,
  OpportunityCommitLevel,
} from '../entities/volunteer-opportunity.entity';

/**
 * A row of the "what you'd actually do" tick list. The title carries the row —
 * an untitled one has nothing to render — but `desc` is the row's optional
 * second line, and the post/edit form offers it as such: neither placeholder is
 * marked required and the detail page renders a title-only row perfectly well.
 * So `desc` allows the empty string rather than requiring a minimum length,
 * which used to 400 the whole submit over a row the poster had left half
 * filled, with nothing on screen naming the row that caused it.
 */
export class OpportunityTaskDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsString() @MaxLength(2000) desc!: string;
}

/** Same shape and the same reasoning as `OpportunityTaskDto`: the label
 *  carries the card, the detail is its optional second line. */
export class OpportunityCommitmentDto {
  @IsString() @MinLength(1) @MaxLength(200) label!: string;
  @IsString() @MaxLength(2000) detail!: string;
}

export class CreateOpportunityDto {
  @IsString() @MinLength(1) @MaxLength(200) org!: string;

  // Existing partner org slug — resolved to `partner_id` via
  // `PartnersService.idBySlug` (see `VolunteeringService.create`/`update`).
  // Deliberately no `@MinLength(1)`: the edit form always sends the FULL
  // desired state, so `''` is how "no organisation is linked" (and unlinking
  // one) reaches `update`, which resolves an empty slug to `null`.
  @IsOptional() @IsString() @MaxLength(100) partnerSlug?: string;

  // Community slug — resolved to `community_id` via
  // `CommunityMembershipService.assertMemberBySlug`, so (unlike
  // `partnerSlug`) an unknown slug 404s and a non-member slug 403s rather
  // than silently resolving to `null` (see `VolunteeringService.create`/
  // `update`). The frontend's combined organization picker only ever sets
  // one of `partnerSlug`/`communitySlug` at a time, sending `''` for the
  // other, so this field skips `@MinLength(1)` for the same reason
  // `partnerSlug` does.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  communitySlug?: string;

  @IsString() @MinLength(1) @MaxLength(200) role!: string;

  // One to three causes, poster-ordered. `causes[0]` is the one the card
  // leads with and tints from, so the order the poster picked is preserved
  // rather than sorted. The cap lives here and in the frontend's chip picker
  // rather than in a CHECK constraint; see
  // `VolunteerOpportunityMultipleCauses1817060000000` for why.
  // `VolunteeringService` de-duplicates before writing, so a client that sends
  // the same cause twice stores it once instead of printing it twice on the
  // card.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_OPPORTUNITY_CAUSES)
  @IsEnum(OpportunityCause, { each: true })
  causes!: OpportunityCause[];

  @IsEnum(OpportunityCommitLevel) commit!: OpportunityCommitLevel;

  // Display-only commitment string (e.g. "2 hrs / week").
  @IsString() @MinLength(1) @MaxLength(200) time!: string;

  @IsString() @MinLength(1) @MaxLength(200) location!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  skills?: string[];

  @IsString() @MinLength(1) @MaxLength(10000) desc!: string;

  @IsInt() @Min(1) spotsTotal!: number;

  @IsString() @MinLength(1) @MaxLength(200) applyRole!: string;

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
  @MaxLength(1000, { each: true })
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

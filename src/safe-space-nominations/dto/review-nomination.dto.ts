import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Body of `POST /admin/safe-space-nominations/:id/acknowledge`. */
export class AcknowledgeNominationDto {
  /** Optional internal note. The nominator is told their nomination was
   * acknowledged; this text stays in the audit trail. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/**
 * Body of `POST /admin/safe-space-nominations/:id/assign` — ties the nomination
 * to the directory listing under review and opens it for member visits.
 *
 * `listingRef` accepts the listing's `ref` OR its `slug`, matching every other
 * `:ref`-addressed listing route. It is required: a nomination cannot collect
 * independent visits until the platform knows which business it is about.
 */
export class AssignNominationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  listingRef!: string;

  /** What the assigning moderator wants the visitors to look at. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export const NOMINATION_DECISION_OUTCOMES = ['award', 'decline'] as const;
export type NominationDecisionOutcome =
  (typeof NOMINATION_DECISION_OUTCOMES)[number];

/**
 * Body of `POST /admin/safe-space-nominations/:id/decide`.
 *
 * `reason` is required on BOTH outcomes. A badge granted with no stated basis
 * is the thing being fixed, and a decline with no stated basis is a member
 * being told nothing.
 *
 * `tier` is required to award and mirrors `listings.safe_space_tier`.
 * `verifierLabel` overrides the free-text provenance line shown on the public
 * page (`listings.safe_space_verifier`); left off, the service composes one
 * from the real independent visit count.
 *
 * `belowVisitBarReason` is the ONLY way to award below
 * `SAFE_SPACE_REQUIRED_INDEPENDENT_VISITS` independent visits. Without it the
 * service refuses, because the published copy commits the platform to three in
 * five separate places ("Minimum 3 independent visits", "Three independent
 * visits", "Three members with no stake in the place go there", the nomination
 * confirmation and the governance page). The bar was computed and recorded on
 * every award and then never consulted, which made all five sentences
 * aspirational.
 *
 * It is an audited exception rather than a hard refusal on purpose. A panel
 * that visited in person, or a place at urgent risk, is a real case, and a
 * ceiling with no door invites the worse workaround of filing vouches to clear
 * it. When it is used, the public provenance line is forced to state the real
 * count, so the exception is visible on the badge itself and not only in the
 * audit trail.
 */
export class DecideNominationDto {
  @IsIn(NOMINATION_DECISION_OUTCOMES)
  outcome!: NominationDecisionOutcome;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  tier?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  verifierLabel?: string;

  /**
   * Why this badge is being awarded below the independent-visit bar. Required
   * to award under the bar, ignored above it and on a decline.
   *
   * The 20-character floor is the same one `ModActionDto.note` carries for a
   * member-facing moderation decision, and it is deliberately stricter than
   * `reason` above, which checks only `@IsNotEmpty()`. Overriding a published
   * guarantee should cost at least as many words as restricting a member.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(20)
  @MaxLength(2000)
  belowVisitBarReason?: string;
}

/** Body of `POST /admin/safe-space-nominations/:id/reopen`. */
export class ReopenNominationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}

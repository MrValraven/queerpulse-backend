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
}

/** Body of `POST /admin/safe-space-nominations/:id/reopen`. */
export class ReopenNominationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}

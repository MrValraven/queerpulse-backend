import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `POST /listings/:ref/claim` body — an active member's request to take
 * ownership of an existing listing. `note` is the free-text explanation a
 * moderator reads in the review queue (e.g. "I'm the owner, here's how to
 * verify me…"). Mirrors `DisputeListingDto`'s `@MaxLength(2000)` cap.
 */
export class CreateListingClaimDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

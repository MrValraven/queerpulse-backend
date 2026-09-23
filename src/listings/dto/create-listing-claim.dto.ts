import {
  Equals,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * `POST /listings/:ref/claim` body — an active member's request to take
 * ownership of an existing listing. `note` is the free-text explanation a
 * moderator reads in the review queue (e.g. "I'm the owner, here's how to
 * verify me…"). Mirrors `DisputeListingDto`'s `@MaxLength(2000)` cap.
 */
export class CreateListingClaimDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;

  /**
   * Claiming a listing means becoming its owner, and the affirming baseline
   * is the condition of being in the directory at all
   * (`CreateListingDto.affirmingBaselineAccepted`,
   * `AcceptListingOwnerOfferDto.affirmingBaselineAccepted`). Required on
   * EVERY claim, including one filed against a listing that already carries
   * an acceptance stamp: that case is a genuine re-affirmation, because the
   * promise binds the person holding the listing, and the person is about to
   * change. `ListingClaimsService.review` stamps `affirmingBaselineAcceptedAt`
   * from this only when the listing's stamp is still null, so an
   * already-accepted listing keeps its original timestamp.
   */
  @IsBoolean()
  @Equals(true, {
    message:
      'Claiming a listing means agreeing to the LGBTQ+ affirming baseline.',
  })
  affirmingBaselineAccepted!: boolean;
}

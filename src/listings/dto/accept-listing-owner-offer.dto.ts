import { Equals, IsBoolean } from 'class-validator';

/** The body a member sends when they accept an owner offer. A decline carries
 * no body, because there is nothing to agree to. */
export class AcceptListingOwnerOfferDto {
  /**
   * Accepting ownership is where the affirming baseline is accepted, by the
   * person it binds. An admin-authored listing carries no acceptance stamp
   * until this lands, so `affirmingBaselineAcceptedAt` means what it says
   * for every row in the table.
   */
  @IsBoolean()
  @Equals(true)
  affirmingBaselineAccepted!: boolean;
}

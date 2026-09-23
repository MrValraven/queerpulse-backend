import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * An admin nominating a member as the owner of a listing that has none.
 *
 * The member is addressed by their public profile slug, the same identifier
 * `InviteListingCoManagerDto` uses, so staff can reach somebody from the
 * profile page they are already looking at.
 */
export class CreateListingOwnerOfferDto {
  /** The member being offered the listing, by public profile slug. */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  memberSlug!: string;

  /**
   * The admin's message to the member. Optional, and member-facing: an
   * unsolicited offer needs context that a co-manager invite does not.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

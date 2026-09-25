import { Type } from 'class-transformer';
import { IsIn, IsOptional, ValidateNested } from 'class-validator';
import { OmitType } from '@nestjs/swagger';
import { CreateListingDto } from './create-listing.dto';
import { CreateListingOwnerOfferDto } from './create-listing-owner-offer.dto';

/**
 * What an admin sends when authoring a listing for a business that has not
 * joined yet.
 *
 * The owner-personal fields and the affirming baseline are absent by
 * construction. They belong to whoever ends up holding the listing, and an
 * admin cannot truthfully answer any of them on a business's behalf. The
 * owner supplies them after accepting, in the editor they land in.
 *
 * Omission is the enforcement: the global `forbidNonWhitelisted`
 * ValidationPipe rejects a body that carries any of them, so an admin who
 * sends `ownerName` gets a 400 and a clear message about it.
 *
 * `contactEmail` is retired (`CreateListingDto` accepts it only so stale
 * member clients keep working, and ignores it). It stays omitted here because
 * no admin client ever sent it, so the admin body keeps rejecting it outright.
 */
export class AdminCreateListingDto extends OmitType(CreateListingDto, [
  'affirmingBaselineAccepted',
  'ownerName',
  'ownerRole',
  'ownerBio',
  'visibility',
  'linkToProfile',
  'contactEmail',
  'consentOuting',
  'consentGuide',
] as const) {
  /** Publish straight away, or send it to the moderation queue. */
  @IsIn(['review', 'live'])
  publishState!: 'review' | 'live';

  /**
   * An optional nomination made in the same form. Extending the offer is a
   * best-effort follow-up of the create, matching the admin-queue announce
   * and `enqueueOwnerNotifyIfNeeded` that already work that way, so a failed
   * nomination still leaves a created listing the admin can offer from the
   * delegation panel.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateListingOwnerOfferDto)
  ownerOffer?: CreateListingOwnerOfferDto;
}

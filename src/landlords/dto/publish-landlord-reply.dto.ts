import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * PRD-249. POST /admin/landlords/recommendations/:id/reply — an admin
 * publishes the named landlord's answer to one recommendation.
 *
 * WHY AN ADMIN AND NOT THE LANDLORD. A landlord in this directory has no
 * account and no claim path: `Landlord` is a community-maintained entry about a
 * third party, its only user column is the member who suggested it, and the
 * whole directory sits behind `ActiveMemberGuard`. There is nobody to
 * authenticate as "this landlord", so the reply reaches the platform through
 * the public `landlord_reply_request` intake form and a human publishes it
 * here. That human is stamped into `landlordReplyPublishedBy`.
 *
 * `text` is the landlord's own words, transcribed. It is NOT staff commentary,
 * and the surface labels it as a reply from the named landlord, published by
 * the team, so a moderator writing their own opinion into this field would be
 * putting words in a real person's mouth on a page other people read.
 */
export class PublishLandlordReplyDto {
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  text!: string;
}

import { IsIn } from 'class-validator';
import { CommunitySupportOfferStatus } from '../entities/community-support-offer.entity';
import type { CommunitySupportOfferResponse } from '../community-support-offers.service';

/**
 * Body for `POST /communities/:slug/support-offers/:id/respond`.
 *
 * Only the two answers the community itself may give. `new` is deliberately
 * not accepted: it is the state platform staff wrote, and letting a community
 * set it back would erase the record of what they said.
 */
export class RespondCommunitySupportOfferDto {
  @IsIn([
    CommunitySupportOfferStatus.Acknowledged,
    CommunitySupportOfferStatus.Declined,
  ])
  response!: CommunitySupportOfferResponse;
}

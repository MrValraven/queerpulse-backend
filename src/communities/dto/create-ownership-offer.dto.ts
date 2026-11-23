import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of `POST /communities/:slug/ownership-offer` (PRD-514): the slug of
 * the roster member the owner offers the community to. A slug, matching how
 * the roster and role routes address a member (`:memberSlug`). The guardrails
 * live in `CommunitiesService.offerOwnership`.
 */
export class CreateOwnershipOfferDto {
  @IsString()
  @IsNotEmpty()
  memberSlug!: string;
}

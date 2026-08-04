import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of `POST /communities/:slug/transfer` — the slug of the roster member
 * who should become the new owner. A slug (not a UUID), matching how the
 * roster/role routes address a member (`:memberSlug`); the service resolves it
 * to a user id via `MemberLookup` and enforces the transfer guardrails
 * (current-owner-only actor, target-must-be-a-member, no self-transfer, no
 * house account) — see `CommunitiesService.transferOwnership`.
 */
export class TransferOwnershipDto {
  @IsString()
  @IsNotEmpty()
  memberSlug!: string;
}

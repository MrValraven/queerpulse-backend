import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of `POST /admin/communities/:slug/reassign-owner`. `memberSlug` names
 * the roster member (by profile slug) who should become the new owner —
 * mirrors `TransferOwnershipDto`'s field naming for the member-facing
 * `POST /communities/:slug/transfer`. Unlike that route, this one is
 * admin-only and works even when the community currently has no owner
 * (`Community.ownerId` is null, `needsOwnerReviewAt` set) — see
 * `AdminCommunitiesService.reassignOwner`.
 */
export class ReassignOwnerDto {
  @IsString()
  @IsNotEmpty()
  memberSlug!: string;
}

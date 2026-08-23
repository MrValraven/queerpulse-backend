import { IsIn } from 'class-validator';
import { RosterRole } from '../entities/community-member.entity';

/**
 * Body of `PATCH /communities/:slug/members/:memberSlug`.
 *
 * `owner` is deliberately NOT an accepted value: ownership is a property of
 * the community (`Community.ownerId`), not something the roster route may
 * hand out, and ownership moves through `POST /communities/:slug/transfer`
 * instead. Rejecting it at the DTO means the service's owner invariants can
 * never be reached by a well-formed request in the first place (defence in
 * depth: the service enforces them regardless).
 *
 * `co_owner` IS accepted, because a role nobody can grant is not a role. It
 * carries owner-level powers, so only the OWNER may grant or revoke it, and
 * only the owner may change the role of someone who already holds it. That is
 * enforced in `CommunitiesService.setMemberRole`, which is where the whole
 * permission model is written down.
 */
export class UpdateMemberRoleDto {
  @IsIn([RosterRole.Member, RosterRole.Mod, RosterRole.CoOwner])
  role!: RosterRole.Member | RosterRole.Mod | RosterRole.CoOwner;
}

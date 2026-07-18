import { IsIn } from 'class-validator';
import { RosterRole } from '../entities/community-member.entity';

/**
 * Body of `PATCH /communities/:slug/members/:memberSlug`.
 *
 * `owner` is deliberately NOT an accepted value: ownership is a property of
 * the community (`Community.ownerId`), not something the roster route may
 * hand out, and there is no ownership-transfer flow in the spec. Rejecting it
 * at the DTO means the service's owner invariants can never be reached by a
 * well-formed request in the first place (defence in depth — the service
 * enforces them regardless).
 */
export class UpdateMemberRoleDto {
  @IsIn([RosterRole.Member, RosterRole.Mod])
  role: RosterRole.Member | RosterRole.Mod;
}

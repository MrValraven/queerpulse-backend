import { IsUUID } from 'class-validator';

/**
 * Body of `POST /admin/communities/:slug/moderators`.
 *
 * `memberId` is the target's user id (their roster identity — the
 * `community_members.user_id` add/remove act on), not the roster row's own
 * primary key: membership is keyed by `(community_id, user_id)` throughout the
 * communities module, and the service resolves the row from the two together.
 * The member must already be on this community's roster; the service 404s
 * otherwise (a moderator is a *promotion* of an existing member, never a way
 * to force-add someone who never joined).
 */
export class AddModeratorDto {
  @IsUUID()
  memberId!: string;
}

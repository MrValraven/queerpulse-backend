/**
 * A standing invitation for one member to join one community.
 *
 * WHY THE TABLE EXISTS (PRD-140, PRD-141). Until now an "invite" was a
 * notification and nothing else: `CommunityInvitesService.invite` sent a
 * `CommunityInviteReceived` bell and wrote no row anywhere. That worked for a
 * `public` or `request` community, where the invitee could reach the page and
 * join or apply unaided, and failed completely for the two tiers the invite
 * exists to serve:
 *
 * - `private`: `getBySlug` and `join` both 404 every non-member, so the
 *   invitee tapped a notification that redirected them to `/communities` with
 *   no explanation, and the community stayed a roster of one.
 * - `invite`: `join` created an ordinary pending request from ANYONE, so the
 *   tier the wizard sells as "only people you've invited can get in" behaved
 *   exactly like `request`.
 *
 * This row is the durable half of that invitation, and it is what those two
 * tiers now gate on: a pending invite lets its holder SEE a private community
 * and JOIN a private or invite-tier one; nobody else can do either.
 *
 * STILL NOT A ROSTER ADD. The module's standing rule is unchanged and this
 * table is how it stays true: nothing here writes to `community_members`, and
 * being invited is not being a member. The invitee still walks through the
 * front door (`POST /communities/:slug/join`) and consents for themselves;
 * accepting is what moves them, and declining costs them nothing. See
 * `CommunityInvitesService`.
 *
 * ONE PENDING INVITE PER (community, member), enforced by the partial unique
 * index `UQ_community_invites_pending` in
 * `1799000000000-CreateCommunityInvites`, the same idiom as
 * `UQ_community_join_requests_pending` and `UQ_ban_evasion_escalations_open`.
 * Re-inviting somebody who already holds a pending invite is answered with the
 * existing one rather than a second bell. The index is partial so a declined
 * or revoked invite does not bar the community from ever inviting that person
 * again.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Where an invitation ended up.
 *
 * `declined` and `revoked` are kept apart because they answer different
 * questions and only one of them is the invitee's own decision: `declined` is
 * the member saying no (their choice, and never surfaced to the community's
 * moderators as anything but "no longer pending"), `revoked` is the community
 * withdrawing the invitation before it was answered. Collapsing them would
 * make "she turned us down" and "we changed our minds" indistinguishable in
 * the one place that has to be careful about the difference.
 */
export enum CommunityInviteStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
  Revoked = 'revoked',
}

@Entity('community_invites')
@Index('UQ_community_invites_pending', ['communityId', 'invitedUserId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
export class CommunityInvite {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  communityId!: string;

  @Column({ type: 'uuid' })
  invitedUserId!: string;

  // The owner/co-owner/moderator who sent it. Nullable and `ON DELETE SET
  // NULL`, the actor-FK convention this module follows
  // (`community_bans.banned_by_user_id`): a moderator erasing their account
  // must not silently withdraw every invitation they ever sent.
  @Column({ type: 'uuid', nullable: true })
  invitedByUserId!: string | null;

  @Column({
    type: 'enum',
    enum: CommunityInviteStatus,
    enumName: 'community_invites_status_enum',
    default: CommunityInviteStatus.Pending,
  })
  status!: CommunityInviteStatus;

  // When the invite left `pending`, whichever way it went. NULL while pending.
  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  // Set only on a `revoked` invite: the moderator who withdrew it. NULL on
  // every other status, and NULL on a revocation whose actor has since erased
  // their account.
  @Column({ type: 'uuid', nullable: true })
  revokedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

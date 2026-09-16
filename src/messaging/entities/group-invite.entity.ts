import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * PRD-353/PRD-358: an offer to join a group, walking `pending ->
 * accepted|declined|revoked`. Written whenever an add cannot seat the
 * candidate directly: the candidate's own `group_add_policy` is
 * `invite_only`, or they have a prior `leftAt`/`removedBy` row in this exact
 * group (a member who left or was removed is never silently re-seated). Never
 * written on a voluntary `POST join/:token`, which seats the candidate
 * straight away instead.
 */
export enum GroupInviteStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
  Revoked = 'revoked',
}

@Entity('group_invites')
// "My pending invites" (`GET /group-invites`).
@Index('IDX_group_invites_invitee_id_status', ['inviteeId', 'status'])
// Idempotency guard for `GroupsService`'s add path: at most one PENDING
// invite per (conversation, invitee), from the partial UNIQUE index
// `1819000000000-AddGroupConsentInvitesAndDissolve` creates. A past
// accepted/declined/revoked row is exempt (the `where` predicate), so
// re-inviting someone who once declined is always possible. Mirrored here,
// same as `UQ_messages_conversation_client_id` on `message.entity.ts`
// mirrors its own migration-created partial index, so `migration:generate`
// never proposes dropping it.
@Index(
  'UQ_group_invites_conversation_invitee_pending',
  ['conversationId', 'inviteeId'],
  {
    unique: true,
    where: `"status" = 'pending'`,
  },
)
export class GroupInvite {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  conversationId!: string;

  /** The invited member. `ON DELETE CASCADE`: an erased account leaves no
   *  invite behind to accept or decline. */
  @Column({ type: 'uuid' })
  inviteeId!: string;

  /**
   * Who sent the invite, else NULL. `ON DELETE SET NULL` (like every other
   * actor FK in this module): an inviter who erases their account must not
   * take the record of having invited someone with them, and the invitee's
   * own accept/decline still has to resolve against a real row.
   */
  @Column({ type: 'uuid', nullable: true })
  inviterId!: string | null;

  /**
   * Idempotency guard for `GroupsService`'s add path: at most one PENDING
   * invite per (conversation, invitee), see the partial UNIQUE index on the
   * migration. A past accepted/declined/revoked row never blocks a fresh
   * invite from following it, so re-inviting someone who once declined is
   * always possible.
   */
  @Column({
    type: 'enum',
    enum: GroupInviteStatus,
    enumName: 'group_invites_status_enum',
    default: GroupInviteStatus.Pending,
  })
  status!: GroupInviteStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /** When the invitee accepted/declined, or an owner/admin revoked it. NULL
   *  while `status` is still `pending`. */
  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;
}

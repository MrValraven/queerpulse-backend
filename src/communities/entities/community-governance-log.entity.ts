import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum GovernanceLogAction {
  RoleChanged = 'role_changed',
  MemberRemoved = 'member_removed',
  OwnershipTransferred = 'ownership_transferred',
  Archived = 'archived',
  Unarchived = 'unarchived',
  Frozen = 'frozen',
  Unfrozen = 'unfrozen',
  // Written by `CommunitiesService.update` for a `PATCH /communities/:slug`
  // that actually changed something, with the field-by-field diff in
  // `metadata`. `accessTier` in particular is the community's most
  // consequential setting (private -> public exposes the roster and every
  // post) and used to change with nothing recorded at all (BE-COM-22).
  SettingsChanged = 'settings_changed',
  // Written by `CommunityOwnerOrphanService.handleOwnerErasure` when a
  // community's owner account is erased and the longest-tenured `mod` on the
  // roster is auto-promoted to owner in their place.
  OwnerAutoPromoted = 'owner_auto_promoted',
  // Written by `CardProgramsService.upsert` when an owner/mod turns a
  // community's membership-card programme on or off.
  CardProgramEnabled = 'card_program_enabled',
  CardProgramDisabled = 'card_program_disabled',
  // Written by `MembershipCardsService.setStatus` when an owner/mod
  // suspends, revokes, or reinstates one member's card.
  CardRevoked = 'card_revoked',
  CardSuspended = 'card_suspended',
  CardReinstated = 'card_reinstated',
  CardReplaced = 'card_replaced',
}

/**
 * An immutable audit trail of governance actions taken against a community's
 * roster/lifecycle — role changes, removals, ownership transfers (manual or
 * automatic), and archive/freeze/unfreeze. Written via
 * `CommunityGovernanceLogService.log()`; nothing else should insert into this
 * table directly, so every entry goes through one typed call site.
 *
 * `actorUserId`/`targetUserId` are `ON DELETE SET NULL` (not `CASCADE`): the
 * acting moderator or the member acted upon may later erase their account,
 * and an audit trail that disappears when its subject leaves is not an audit
 * trail. `communityId` is `ON DELETE CASCADE` — once the community itself is
 * gone there is nothing left for the log to be an audit trail of.
 */
@Entity('community_governance_log')
// Backs the paginated reader (`GET /admin/communities/:slug/governance-log`,
// BE-COM-15): `community_id` filter + `created_at DESC, id DESC` sort. The
// migration (`1793620000000-AddCommunityGovernanceLogCommunityCreatedAtIndex`)
// creates it with the explicit `DESC` ordering — the TypeORM decorator API
// doesn't express column sort order, so the exact DDL lives there, not here
// (same caveat as `RoadmapAuditLog`'s created_at index).
@Index('IDX_community_governance_log_community_id_created_at', [
  'communityId',
  'createdAt',
  'id',
])
export class CommunityGovernanceLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_community_governance_log_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  // Nullable: some entries are system-driven (e.g. an auto-freeze from report
  // pile-up, or the owner-erasure auto-promotion) with no human actor. Also
  // NULLed by `ON DELETE SET NULL` if the acting member later erases their
  // account.
  @Column({ type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @Column({
    type: 'enum',
    enum: GovernanceLogAction,
    enumName: 'community_governance_log_action_enum',
  })
  action!: GovernanceLogAction;

  // The member the action was taken against (role change/removal target,
  // outgoing/incoming owner on a transfer). Null for actions with no single
  // target (archive/freeze/unfreeze).
  @Column({ type: 'uuid', nullable: true })
  targetUserId!: string | null;

  // Free-form context for the action, e.g. `{ fromRole, toRole }` for a role
  // change or `{ reason: 'owner account erased' }` for an auto-promotion.
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

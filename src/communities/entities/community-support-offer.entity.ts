import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { CommunitySupportOption } from '../community-support-options';

/**
 * Where an offer of support stands. The community's own owner/co-owners/mods
 * move it: `new` is what a staff member wrote, `acknowledged` means the
 * community has taken it up, `declined` means they would rather not.
 *
 * There is deliberately no `withdrawn`: the admin surface has no undo (the
 * moment an offer is written its recipients hold a bell notification, and
 * nothing can un-ring that), so the only transitions are the two the
 * community makes.
 */
export enum CommunitySupportOfferStatus {
  New = 'new',
  Acknowledged = 'acknowledged',
  Declined = 'declined',
}

/**
 * One offer of support from platform staff to a community that is having a
 * hard time: which kinds of help were offered, the note the staff member
 * wrote, and what the community said back.
 *
 * This exists because the admin "Offer support" modal used to write nothing at
 * all (OPS-05): it showed a success toast and an Undo, and the community never
 * heard from anyone. The row is the offer; the community's owners and
 * moderators read it in their own mod-tools console.
 *
 * `options` is a `text[]` of the stable keys in `community-support-options.ts`,
 * validated against that registry at the DTO boundary. `note` is stored as
 * plain text: the service runs it through `toStoredPlainText` before it
 * reaches the column, so no markup is ever persisted (see
 * `community-plain-text.ts`).
 *
 * FK behaviour. `community_id` CASCADEs — an offer of support to a room that
 * no longer exists is nothing. Both actor columns are nullable and
 * `ON DELETE SET NULL`, the actor-FK convention this module follows and the
 * same posture `reports.assigned_moderator_id` takes: the account-erasure
 * sweep must never be blocked by a record of something a staff member did, and
 * the community keeps the offer it was made even after the person who made it
 * has gone. `offered_by_name` is a write-time snapshot for exactly that case,
 * mirroring `mod_audit_logs.target_name`.
 *
 * Paired migration `1795660000000-CreateCommunitySupportOffers`.
 */
@Entity('community_support_offers')
export class CommunitySupportOffer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Every read of this table is "the offers for one community", newest first.
  // The migration creates the index with an explicit `created_at DESC`; the
  // decorator API cannot express column sort order (same caveat
  // `CommunityGovernanceLog` records for its own index).
  @Index('IDX_community_support_offers_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  // NULLed when the staff member who offered erases their account. The offer
  // itself stands, and `offeredByName` still says who made it.
  @Column({ type: 'uuid', nullable: true })
  offeredByUserId!: string | null;

  /**
   * A write-time snapshot of the offering staff member's display name, so the
   * pane can still say who offered after the FK above has been NULLed. Null
   * only when the staff member had no profile row at the time of writing.
   */
  @Column({ type: 'varchar', nullable: true })
  offeredByName!: string | null;

  /** Stable option keys from `COMMUNITY_SUPPORT_OPTIONS`. Never empty: the DTO
   *  requires at least one, because an offer of nothing is not an offer. */
  @Column({ type: 'text', array: true, default: '{}' })
  options!: CommunitySupportOption[];

  /** Staff-authored prose to the community's moderators. Plain text only. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({
    type: 'enum',
    enum: CommunitySupportOfferStatus,
    enumName: 'community_support_offers_status_enum',
    default: CommunitySupportOfferStatus.New,
  })
  status!: CommunitySupportOfferStatus;

  // Which of the community's own staff answered, and when. Both null while the
  // offer is still `new`; the user FK is `ON DELETE SET NULL` for the same
  // reason as the one above.
  @Column({ type: 'uuid', nullable: true })
  respondedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

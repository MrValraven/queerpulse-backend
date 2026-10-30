import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';
import { Listing } from './listing.entity';

/** Where one persona or member sits on one listing's team. */
export enum ListingTeamMemberStatus {
  /** An invite or a request waiting for the other side. Shows nowhere public. */
  Pending = 'pending',
  /** Both sides agreed. The only status that shows on the listing and the persona. */
  Accepted = 'accepted',
  /** The receiving side said no. */
  Declined = 'declined',
  /** The side that started it took it back before an answer. */
  Cancelled = 'cancelled',
  /** The listing side took an accepted persona off the team. */
  Removed = 'removed',
  /** The persona stepped off the team. */
  Left = 'left',
}

/** Which side started the link. Member rows are always started by the listing. */
export enum ListingTeamInitiator {
  Listing = 'listing',
  Persona = 'persona',
}

/** The two statuses that occupy a slot. At most one such row exists per pair. */
export const LIVE_LISTING_TEAM_STATUSES: readonly ListingTeamMemberStatus[] = [
  ListingTeamMemberStatus.Pending,
  ListingTeamMemberStatus.Accepted,
];

/**
 * A consent-based link between a business listing and a persona or a member
 * ("Meet the team").
 *
 * A row has exactly one subject: `subprofileId` for a persona or `userId` for
 * a member, never both (`CHK_listing_team_members_one_subject`). A member row
 * is always started by the listing. Rows belong to the listing and to that
 * subject. `requestedByUserId` is audit only and never leaves the server, and
 * neither does `userId`. `answeredAt` is set on accept and on decline.
 * `position` is set while the row is accepted and null otherwise.
 */
@Entity('listing_team_members')
@Check(
  'CHK_listing_team_members_position',
  `("status" = 'accepted') = ("position" IS NOT NULL)`,
)
@Check(
  'CHK_listing_team_members_one_subject',
  `(("subprofile_id" IS NOT NULL)::int + ("user_id" IS NOT NULL)::int) = 1`,
)
@Check(
  'CHK_listing_team_members_member_listing_initiated',
  `"user_id" IS NULL OR "initiated_by" = 'listing'`,
)
@Index('UQ_listing_team_members_live_pair', ['listingId', 'subprofileId'], {
  unique: true,
  where: `"status" IN ('pending', 'accepted')`,
})
@Index('UQ_listing_team_members_live_member', ['listingId', 'userId'], {
  unique: true,
  where: `"status" IN ('pending', 'accepted')`,
})
@Index('IDX_listing_team_members_listing_status', ['listingId', 'status'])
@Index('IDX_listing_team_members_subprofile_status', ['subprofileId', 'status'])
@Index('IDX_listing_team_members_user_status', ['userId', 'status'])
@Index('IDX_listing_team_members_requested_by_user_id', ['requestedByUserId'])
export class ListingTeamMember {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  listingId!: string;

  // FK to `listings(id)` ON DELETE CASCADE.
  @ManyToOne(() => Listing, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'listing_id',
    foreignKeyConstraintName: 'FK_listing_team_members_listing',
  })
  listing?: Listing;

  /** Null on a member row. */
  @Column({ type: 'uuid', nullable: true })
  subprofileId!: string | null;

  // FK to `subprofiles(id)` ON DELETE CASCADE ON UPDATE CASCADE.
  @ManyToOne(() => Subprofile, {
    nullable: true,
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_listing_team_members_subprofile',
  })
  subprofile?: Subprofile | null;

  /** The member on a member row; null on a persona row. Never on the wire. */
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  // FK to `users(id)` ON DELETE CASCADE.
  @ManyToOne(() => User, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_listing_team_members_user',
  })
  user?: User | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  roleLabel!: string | null;

  @Column({
    type: 'enum',
    enum: ListingTeamMemberStatus,
    enumName: 'listing_team_members_status_enum',
    default: ListingTeamMemberStatus.Pending,
  })
  status!: ListingTeamMemberStatus;

  @Column({
    type: 'enum',
    enum: ListingTeamInitiator,
    enumName: 'listing_team_members_initiated_by_enum',
  })
  initiatedBy!: ListingTeamInitiator;

  @Column({ type: 'uuid', nullable: true })
  requestedByUserId!: string | null;

  // FK to `users(id)` ON DELETE SET NULL.
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'requested_by_user_id',
    foreignKeyConstraintName: 'FK_listing_team_members_requested_by',
  })
  requestedBy?: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  answeredAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  position!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

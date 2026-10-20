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

/** Where one persona sits on one listing's team. */
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

/** Which side started the link. */
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
 * A consent-based link between a business listing and a persona ("Meet the team").
 *
 * Rows belong to the listing and to the persona. `requestedByUserId` is audit
 * only and never leaves the server. `answeredAt` is set on accept and on
 * decline. `position` is set while the row is accepted and null otherwise.
 */
@Entity('listing_team_members')
@Check(
  'CHK_listing_team_members_position',
  `("status" = 'accepted') = ("position" IS NOT NULL)`,
)
@Index('UQ_listing_team_members_live_pair', ['listingId', 'subprofileId'], {
  unique: true,
  where: `"status" IN ('pending', 'accepted')`,
})
@Index('IDX_listing_team_members_listing_status', ['listingId', 'status'])
@Index('IDX_listing_team_members_subprofile_status', ['subprofileId', 'status'])
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

  @Column({ type: 'uuid' })
  subprofileId!: string;

  // FK to `subprofiles(id)` ON DELETE CASCADE ON UPDATE CASCADE.
  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_listing_team_members_subprofile',
  })
  subprofile?: Subprofile;

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

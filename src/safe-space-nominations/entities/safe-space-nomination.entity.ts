import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Lifecycle of a member-submitted safe-space nomination. Stored as a plain
 * varchar (not a PG enum) so a future review outcome can be added without a
 * schema migration — the same extensible-status precedent used for staff-role
 * codes. New rows always start `pending`; a moderator later moves them on.
 */
export type SafeSpaceNominationStatus = 'pending' | 'approved' | 'rejected';

export const SAFE_SPACE_NOMINATION_STATUSES: SafeSpaceNominationStatus[] = [
  'pending',
  'approved',
  'rejected',
];

/**
 * One member's suggestion that a place should be reviewed for the QueerPulse
 * safe-space badge. This is an intake queue, not a published record: rows are
 * read only by the admin/moderation surface (`GET /admin/safe-space-nominations`)
 * until the team acts on them, so a submission never surfaces publicly on its
 * own — an honest "we'll review it" flow rather than a write-only orphan.
 *
 * `listingRef` optionally ties the nomination to an existing directory listing
 * (its slug/ref) when the member nominated a place we already list; it's null
 * for a free-text place that isn't in the directory yet.
 */
@Entity('safe_space_nominations')
export class SafeSpaceNomination {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_safe_space_nominations_nominator_id')
  @Column({ type: 'uuid' })
  nominatorId!: string;

  @Column({ type: 'varchar', length: 200 })
  placeName!: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  placeType!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  listingRef!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Index('IDX_safe_space_nominations_status')
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: SafeSpaceNominationStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

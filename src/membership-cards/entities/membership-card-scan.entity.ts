import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum CardScanResult {
  Valid = 'valid',
  Expired = 'expired',
  Revoked = 'revoked',
  Suspended = 'suspended',
  WrongCommunity = 'wrong_community',
  AlreadyCheckedIn = 'already_checked_in',
}

/**
 * Door check-in log. Created in Phase 1 so Phase 2 needs no second migration,
 * and DELIBERATELY UNWRITTEN in Phase 1: this phase has no check-in, and
 * logging every public verification would build the behavioural record the
 * design forbids (spec §K.2).
 *
 * Fields are the minimum door reconciliation and dispute resolution need.
 * Rows are auto-purged on a 90 day window by the Phase 2 sweeper. There is
 * deliberately no "where has this member shown their card" query surface.
 */
@Entity('membership_card_scans')
export class MembershipCardScan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_membership_card_scans_card_id')
  @Column({ type: 'uuid' })
  cardId!: string;

  @Column({ type: 'uuid', nullable: true })
  eventId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  scannedByUserId!: string | null;

  @Column({
    type: 'enum',
    enum: CardScanResult,
    enumName: 'membership_card_scans_result_enum',
  })
  result!: CardScanResult;

  // Indexed for the Phase 2 retention sweeper's `WHERE scanned_at < cutoff`.
  @Index('IDX_membership_card_scans_scanned_at')
  @CreateDateColumn({ type: 'timestamptz' })
  scannedAt!: Date;
}

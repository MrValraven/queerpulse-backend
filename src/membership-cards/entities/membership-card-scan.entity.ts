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
 * Card verification log. Written by `CardScanLogService`, and ONLY once a
 * signed token has resolved to a real card of the right generation, so the
 * public verify endpoint cannot be used to spam rows in here and a forged
 * code leaves no trace.
 *
 * Fields are the minimum dispute resolution and abuse detection need. No IP,
 * no user agent, no geolocation, no fingerprint of whoever scanned:
 * `scannedByUserId` is null for every row a public verification writes,
 * because that caller has no identity. `eventId` stays null until a door
 * check-in surface exists.
 *
 * Rows are purged on a 90 day window by `CardScanRetentionService`. There is
 * deliberately no "where has this member shown their card" query surface: the
 * only reads are an aggregate for one card programme and a per-CARD tally on
 * the issuer's roster, which is the leaked-or-shared-card signal (spec
 * §K.2). Nothing may turn this into a behavioural record of a member.
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

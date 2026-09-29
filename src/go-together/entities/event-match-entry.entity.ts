import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { HostAnswers, Lens } from '../go-together-questionnaire.catalog';

export const ENTRY_STATUSES = [
  'waiting',
  'grouped',
  'unmatched',
  'withdrawn',
] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const PAIR_STATUSES = ['none', 'pending', 'accepted'] as const;
export type PairStatus = (typeof PAIR_STATUSES)[number];

/**
 * One member's opt-in for one gathering. A pair is two entries pointing at
 * each other with `pairStatus = accepted`; a pending invite lives on the
 * inviter's entry only, and the friend's entry is created when they accept.
 */
@Entity('event_match_entries')
@Unique('UQ_event_match_entries_event_user', ['eventId', 'userId'])
@Index('IDX_event_match_entries_event_status', ['eventId', 'status'])
export class EventMatchEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  eventId!: string;

  @Index('IDX_event_match_entries_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Index('IDX_event_match_entries_pair_partner_id')
  @Column({ type: 'uuid', nullable: true })
  pairPartnerId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'none' })
  pairStatus!: PairStatus;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  hostAnswers!: HostAnswers;

  @Column({ type: 'varchar', length: 24, nullable: true })
  lens!: Lens | null;

  @Column({ type: 'timestamptz', nullable: true })
  lensConsentedAt!: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'waiting' })
  status!: EntryStatus;

  @Index('IDX_event_match_entries_group_id')
  @Column({ type: 'uuid', nullable: true })
  groupId!: string | null;

  @Index('IDX_event_match_entries_merge_offer_group_id', {
    where: '"merge_offer_group_id" IS NOT NULL',
  })
  @Column({ type: 'uuid', nullable: true })
  mergeOfferGroupId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  checkedInAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  leftEventAt!: Date | null;

  /** Set when the "no group this time" notice went out, so it goes out once
   *  per state (the final notice at the late-group pass clears and re-stamps). */
  @Column({ type: 'timestamptz', nullable: true })
  unmatchedNotifiedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

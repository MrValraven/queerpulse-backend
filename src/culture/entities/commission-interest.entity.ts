import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Mirrors the frontend's `CommissionCat` union in
// queerpulse/src/features/culture/culture.data.tsx.
export enum CommissionCategory {
  Photo = 'Photo',
  Music = 'Music',
  Writing = 'Writing',
  Design = 'Design',
  Film = 'Film',
}

/**
 * A member expressing interest in a Commission Board project (see
 * `CommissionInterestModal.tsx` — "Express interest" on a commission card).
 * The commission itself is curated editorial content that lives entirely in
 * the frontend's `culture.data.tsx` (`COMMISSIONS` array) — there is no
 * `commission` table to reference, so the row denormalizes the commission's
 * title/category/owner name verbatim at submission time (mirrors how
 * `SavedItem`/`Draft` snapshot caller-supplied identifiers rather than
 * joining to a row that doesn't exist on the server).
 */
@Entity('commission_interest')
export class CommissionInterest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_commission_interest_member_id')
  @Column({ type: 'uuid' })
  memberId: string;

  @Column({ type: 'varchar', length: 500 })
  commissionTitle: string;

  @Column({ type: 'enum', enum: CommissionCategory })
  commissionCategory: CommissionCategory;

  // Verbatim `commission.who.name` at the time of submission — who the
  // member is reaching out to (denormalized for the same reason as
  // `commissionTitle`; see class doc).
  @Column({ type: 'varchar', length: 200 })
  recipientName: string;

  // The modal's optional "Your message" textarea.
  @Column({ type: 'text', nullable: true })
  message: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * String-union "enum" stored as `varchar` (repo idiom, see
 * `MagazinePiece.stage` precedent). Tracks where the fee sits relative to the
 * writer being paid.
 */
export type PaymentStatus = 'agreed' | 'approved_unpaid' | 'paid';

/**
 * The money side of a commissioned piece (spec §7.2 Money tab). One row per
 * `MagazinePiece` — enforced by a unique index on `pieceId`.
 */
@Entity('magazine_payment')
export class MagazinePayment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_magazine_payment_piece', { unique: true })
  @Column({ type: 'uuid' })
  pieceId!: string;

  @Column({ type: 'varchar' })
  fee!: string;

  @Column({ type: 'varchar', nullable: true })
  expenses!: string | null;

  @Column({ type: 'varchar', nullable: true })
  invoice!: string | null;

  @Column({ type: 'date', nullable: true })
  filedOn!: string | null;

  @Column({ type: 'varchar', default: '21 days' })
  terms!: string;

  @Column({ type: 'date', nullable: true })
  dueOn!: string | null;

  @Column({ type: 'varchar', default: 'agreed' })
  status!: PaymentStatus;

  @Column({ type: 'date', nullable: true })
  paidOn!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

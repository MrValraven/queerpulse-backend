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
 *
 * CON-18 — money lives in `numeric`, never `varchar` and never a float.
 * `feeAmount`/`expensesAmount` are Postgres `numeric(12,2)`, which the `pg`
 * driver hands back as a STRING ("420.00"). Keep it a string all the way
 * through the DTO and the wire: parsing it into a JS `number` reintroduces
 * binary-float rounding on exactly the values a magazine has to account for.
 * Totals are summed in Postgres (`MagazineIssueCostsService`), never in JS.
 *
 * `feeText`/`expensesText` preserve whatever free text the column held before
 * the conversion, plus anything a later edit records that is not an amount
 * ("18 travel, receipts with Marta"). An amount and its text can both be set:
 * the amount is what totals, the text is what the desk actually wrote.
 */
@Entity('magazine_payment')
export class MagazinePayment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_magazine_payment_piece', { unique: true })
  @Column({ type: 'uuid' })
  pieceId!: string;

  /**
   * ISO 4217 code the two amounts on this row are denominated in. One
   * currency per payment: a single commission is never split across two.
   */
  @Column({ type: 'varchar', length: 3, default: 'EUR' })
  currency!: string;

  /** Agreed fee as a decimal string ("420.00"), `null` when never priced. */
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  feeAmount!: string | null;

  /** The fee as the desk originally wrote it, when that says more than the number. */
  @Column({ type: 'varchar', nullable: true })
  feeText!: string | null;

  /** Reimbursed expenses as a decimal string, `null` when none were filed. */
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  expensesAmount!: string | null;

  /** The expenses as the desk originally wrote them ("18 travel"). */
  @Column({ type: 'varchar', nullable: true })
  expensesText!: string | null;

  /**
   * The writer's invoice REFERENCE ("INV-2026-084"), never an amount — it
   * stays `varchar` for that reason and is excluded from every total.
   */
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

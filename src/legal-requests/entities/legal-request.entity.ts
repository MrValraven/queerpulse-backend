import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { LegalRequestDataCategory } from '../legal-request-vocabulary';
import {
  LegalRequestOutcome,
  LegalRequestType,
} from '../legal-request-vocabulary';

/**
 * One demand from a court, a police force, a ministry or any other arm of a
 * state for member data or for content to come down, and what QueerPulse did
 * about it (PRD-32).
 *
 * Until this table existed the platform had no register at all: the public
 * Transparency Report counted reports, moderator actions and appeals, and said
 * nothing about the one figure a queer community cares about most, which is
 * how often somebody with a warrant asked for its members. A report that omits
 * that reads as an answer, and the answer it reads as is the wrong one.
 *
 * ## Who writes here
 *
 * Only an admin, through `AdminLegalRequestsController`. This is the most
 * sensitive table in the product: every row names a state body and a number of
 * members it came for, so the moderator role is deliberately not enough.
 *
 * ## Why nothing is ever deleted
 *
 * There is no delete path, in the API or here. A register of state demands
 * that can be quietly emptied is worth less than no register at all, because
 * its silence would still be published as a zero. A row entered in error is
 * VOIDED instead: `voidedAt`, `voidedByUserId` and `voidReason` are stamped,
 * the row stays exactly where it is, and the public report both drops it from
 * every figure and publishes how many records were voided in the period, so
 * emptying the register is itself a published number.
 *
 * ## Gag orders
 *
 * `isUnderGagOrder` marks a demand the platform is legally barred from
 * describing. Such a row is still recorded in full for internal use and is
 * still counted in every published total, because a count is not an
 * itemisation. The report never itemises anything anyway, so a gagged request
 * and an ordinary one are published identically: as one more request that
 * arrived.
 *
 * Paired migration `1795820000000-CreateLegalRequests`.
 */
@Entity('legal_requests')
// The register's one range scan: everything received inside a reporting
// quarter, and the admin list in the same newest-first order. The migration
// creates it with an explicit `received_on DESC, id DESC`; the decorator API
// cannot express column sort order (the caveat `CommunitySupportOffer` records
// for its own index). Deliberately not partial on `voided_at IS NULL`: the
// admin list reads voided rows too, and a register this small gains nothing
// from a second index it would then need.
@Index('IDX_legal_requests_received_on', ['receivedOn', 'id'])
export class LegalRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Who asked: the court, police force, ministry or agency named on the
   * instrument, as written on it. Free text because the world's institutions
   * are not an enum, and stripped to plain text at the write boundary
   * (`toStoredPlainText`) so the column can never hold markup.
   *
   * Never published. It is the single most identifying field on the row.
   */
  @Column({ type: 'varchar', length: 200 })
  requestingBody!: string;

  /**
   * Which legal system it came out of: a country, or a country and region
   * where that is what makes the demand legible. Free text for the same reason
   * as `requestingBody`, and likewise never published.
   */
  @Column({ type: 'varchar', length: 120 })
  jurisdiction!: string;

  @Column({
    type: 'enum',
    enum: LegalRequestType,
    enumName: 'legal_requests_type_enum',
  })
  requestType!: LegalRequestType;

  /**
   * The day the demand reached QueerPulse, `YYYY-MM-DD`. A `date` rather than
   * a timestamp: the hour a subpoena landed is not a fact anybody needs, and a
   * timestamp would put a per-request instant in a table whose aggregate is
   * published. It is also the axis the reporting window slices on.
   */
  @Column({ type: 'date' })
  receivedOn!: string;

  /** How many member accounts the demand named. Zero is legitimate: a takedown
   *  demand about one post names no account. */
  @Column({ type: 'integer', default: 0 })
  accountsAffected!: number;

  @Column({
    type: 'enum',
    enum: LegalRequestOutcome,
    enumName: 'legal_requests_outcome_enum',
    default: LegalRequestOutcome.Pending,
  })
  outcome!: LegalRequestOutcome;

  /**
   * Which categories of member data actually left the platform, as stable keys
   * from `LEGAL_REQUEST_DATA_CATEGORIES`, validated against that registry at
   * the DTO boundary. An empty array means nothing was handed over, which is
   * the value a refused, withdrawn or still-pending request carries.
   */
  @Column({ type: 'text', array: true, default: '{}' })
  dataDisclosed!: LegalRequestDataCategory[];

  /**
   * The day the affected members were told, `YYYY-MM-DD`, or null when they
   * have not been. Notice reaches a member in the one channel this platform
   * has, an in-app QueerPulse notification: no email is sent, here or
   * anywhere.
   */
  @Column({ type: 'date', nullable: true })
  memberNotifiedOn!: string | null;

  /**
   * How many of `accountsAffected` were actually told. Kept as its own number
   * rather than inferred from `memberNotifiedOn`, because a notice that went
   * to three of eleven named accounts is three, and inferring it from a date
   * would publish eleven. Never greater than `accountsAffected`, enforced by
   * the service.
   */
  @Column({ type: 'integer', default: 0 })
  accountsNotified!: number;

  /**
   * Why the affected members were not told, when they were not. Required by
   * the service on any record where data was disclosed and nobody was
   * notified, so "we did not tell them" is always a decision on file rather
   * than a blank. Plain text, never published.
   */
  @Column({ type: 'text', nullable: true })
  notificationWithheldReason!: string | null;

  /** True when the platform is legally barred from describing this demand.
   *  The row is still counted in every published total. */
  @Column({ type: 'boolean', default: false })
  isUnderGagOrder!: boolean;

  /** Staff-only working notes. NEVER published, by any route, at any
   *  aggregation. No public DTO in this repo carries this column. */
  @Column({ type: 'text', nullable: true })
  internalNote!: string | null;

  /**
   * The admin who recorded the row. `ON DELETE SET NULL`, the actor-FK
   * convention this repo follows: the account-erasure sweep must never be
   * blocked by, or able to erase, the record of a state demand.
   */
  @Column({ type: 'uuid', nullable: true })
  recordedByUserId!: string | null;

  /** Write-time snapshot of the recording admin's display name, so the row
   *  still says who entered it after the FK above has been NULLed. Mirrors
   *  `mod_audit_logs.target_name`. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  recordedByName!: string | null;

  // --- void (there is no delete) ---

  @Column({ type: 'timestamptz', nullable: true })
  voidedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  voidedByUserId!: string | null;

  /** Why the record was struck. Required to void, so a voided row always says
   *  what was wrong with it. */
  @Column({ type: 'text', nullable: true })
  voidReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

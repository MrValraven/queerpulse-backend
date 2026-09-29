import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * The fields of a register row an admin can amend through
 * `PATCH /admin/legal-requests/:id`, in the order the amendment diff walks
 * them. The void columns are absent on purpose: striking a record has its own
 * route, and it stamps its own actor on the row.
 */
export const LEGAL_REQUEST_AMENDABLE_FIELDS = [
  'requestingBody',
  'jurisdiction',
  'requestType',
  'receivedOn',
  'accountsAffected',
  'outcome',
  'dataDisclosed',
  'memberNotifiedOn',
  'accountsNotified',
  'notificationWithheldReason',
  'isUnderGagOrder',
  'internalNote',
] as const;

export type LegalRequestAmendableField =
  (typeof LEGAL_REQUEST_AMENDABLE_FIELDS)[number];

/** A stored value of one amendable field, as it reads back from the row. */
export type LegalRequestFieldValue =
  string | number | boolean | string[] | null;

/** One field's stored value before and after the amendment. */
export interface LegalRequestFieldChange {
  from: LegalRequestFieldValue;
  to: LegalRequestFieldValue;
}

/** Only the fields whose stored value actually changed carry an entry. */
export type LegalRequestAmendmentChanges = Partial<
  Record<LegalRequestAmendableField, LegalRequestFieldChange>
>;

/**
 * One amendment to a register row (ENG-487): who made it, when, and exactly
 * which stored values moved.
 *
 * Creating a record stamps `recordedByUserId` and voiding it stamps
 * `voidedByUserId`, and before this table an edit in between stamped nothing:
 * the PATCH overwrote the row in place, so a changed outcome or a lowered
 * notified count carried no author and no trace of what it said before. On a
 * table whose totals are published, that is a public number moving with
 * nobody's name on it.
 *
 * ## Why its own table
 *
 * `mod_audit_logs` is the one generic trail, and its global feed is readable
 * by moderators, while this register is admin-only. A history written there
 * would hand the moderation rota the requesting bodies and gag-order flags the
 * register's role guard exists to keep from them.
 *
 * ## Shape
 *
 *  - `changes` is `{ [field]: { from, to } }` over the stored values, and holds
 *    only the fields that moved. A PATCH that changed nothing writes no row.
 *  - `actorUserId` is nullable and `ON DELETE SET NULL`, the actor-FK
 *    convention `legal_requests.recorded_by_user_id` follows; `actorName` is
 *    the write-time snapshot that keeps the row readable after that.
 *  - `legalRequestId` cascades on delete. The register has no delete path, so
 *    this only ever matters to a maintainer clearing a database by hand.
 *
 * Append-only: nothing in the service updates or removes a row here.
 *
 * Paired migration `1827010000000-CreateLegalRequestAmendments`.
 */
@Entity('legal_request_amendments')
// A record's history, newest first: the one read this table serves. Its
// leading column also covers the `legal_request_id` FK, so that column carries
// no index of its own. Declared at class level because the property-level
// decorator takes no column list.
@Index('IDX_legal_request_amendments_request_created', [
  'legalRequestId',
  'createdAt',
])
// Serves the account-erasure sweep that nulls `actor_user_id` (ENG-32).
// Partial, since a null actor is never looked up.
@Index('IDX_legal_request_amendments_actor_user_id', ['actorUserId'], {
  where: `"actor_user_id" IS NOT NULL`,
})
export class LegalRequestAmendment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  legalRequestId!: string;

  /** The admin who made the amendment. Null once their account is erased. */
  @Column({ type: 'uuid', nullable: true })
  actorUserId!: string | null;

  /** Write-time snapshot of the amending admin's display name, taken the same
   *  way as `LegalRequest.recordedByName`. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  actorName!: string | null;

  @Column({ type: 'jsonb' })
  changes!: LegalRequestAmendmentChanges;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

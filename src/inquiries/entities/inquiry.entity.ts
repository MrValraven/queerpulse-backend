import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Which marketing form produced the inquiry. */
export const INQUIRY_KINDS = ['contact', 'partner'] as const;

export type InquiryKind = (typeof INQUIRY_KINDS)[number];

/** Ops triage state. New rows land as `new`; staff flip to `handled`. */
export const INQUIRY_STATUSES = ['new', 'handled'] as const;

export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

/**
 * A message left through one of the public marketing forms — the Contact page
 * (`kind = 'contact'`) or the For-Organisations partnership form
 * (`kind = 'partner'`). Rows are written by anonymous visitors (the `POST` is
 * `@Public()`), so there is no `user_id`: the sender identifies themselves by
 * the `name`/`email` they type. `subject` carries the form's topic/interest
 * selector, `orgName` the partner form's organisation field (null for contact).
 *
 * `kind` and `status` are plain varchars (NOT Postgres enums) so a future form
 * kind or triage state never needs an enum migration — widening either set is a
 * one-line change to {@link INQUIRY_KINDS} / {@link INQUIRY_STATUSES} here, and
 * the allowed values are enforced by the DTOs' `@IsIn` on the way in. Every
 * read hand-maps to `InquiryDTO`; the entity is never returned raw.
 *
 * `handledById` / `handledAt` are the triage provenance the admin console
 * shows: who took the message off the pile and when. Both are cleared when an
 * inquiry is moved back to `new`, because a re-opened inquiry has no handler.
 * `handledById` is a nullable FK → `users(id)` with `ON DELETE SET NULL`
 * (declared in the migration, which owns the schema) so a staff account being
 * erased de-links the triage record rather than deleting the inquiry. It is a
 * plain uuid column with no `@ManyToOne` relation — the handler's display name
 * is resolved through a batched `MemberLookup`, mirroring
 * `IntakeSubmission.submitterId`, so a list read never joins.
 */
@Entity('inquiries')
// The console's default read is "newest first, filtered by status", so the
// composite (status, created_at) is the index that actually serves it: equality
// on status, then a backwards scan for the ORDER BY. `IDX_inquiries_status`
// below is kept as-is — renaming or dropping an index an applied migration
// created is churn this read does not need.
@Index('IDX_inquiries_status_created_at', ['status', 'createdAt'])
export class Inquiry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  kind!: InquiryKind;

  @Column({ type: 'varchar' })
  senderName!: string;

  @Column({ type: 'varchar' })
  email!: string;

  @Column({ type: 'varchar', nullable: true })
  subject!: string | null;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'varchar', nullable: true })
  orgName!: string | null;

  @Index('IDX_inquiries_status')
  @Column({ type: 'varchar', default: 'new' })
  status!: InquiryStatus;

  /** The admin who moved this inquiry to `handled`; null while it is `new`. */
  @Index('IDX_inquiries_handled_by_id')
  @Column({ type: 'uuid', nullable: true })
  handledById!: string | null;

  /** When it was moved to `handled`; null while it is `new`. */
  @Column({ type: 'timestamptz', nullable: true })
  handledAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Which marketing form produced the inquiry. */
export type InquiryKind = 'contact' | 'partner';

/** Ops triage state. New rows land as `new`; staff flip to `handled`. */
export type InquiryStatus = 'new' | 'handled';

/**
 * A message left through one of the public marketing forms — the Contact page
 * (`kind = 'contact'`) or the For-Organisations partnership form
 * (`kind = 'partner'`). Rows are written by anonymous visitors (the `POST` is
 * `@Public()`), so there is no `user_id`: the sender identifies themselves by
 * the `name`/`email` they type. `subject` carries the form's topic/interest
 * selector, `orgName` the partner form's organisation field (null for contact).
 *
 * `kind` and `status` are plain varchars (not Postgres enums) so a future form
 * kind or triage state never needs an enum migration — the allowed values are
 * enforced by the DTO's `@IsIn` on the way in. Every read hand-maps to
 * {@link InquiryDTO}; the entity is never returned raw.
 */
@Entity('inquiries')
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { EmailTemplateLocales } from '../email-template-content';
import type { EmailTemplatePurpose } from '../email-template-purposes';

/**
 * One admin-authored email a staff member copies and sends by hand from their
 * own mailbox. QueerPulse delivers no email: nothing reads this table to send
 * anything, and no column records a send.
 *
 * `locales` holds both languages on the row, validated at the write boundary
 * by `validateEmailTemplateLocales`, so English and Portuguese cannot drift
 * into two unrelated templates.
 */
@Entity('email_templates')
@Index('IDX_email_templates_active_purpose', ['isActive', 'purpose'])
export class EmailTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Staff-facing name. Unique, so a picker row is identifiable at a glance
   *  and the seed migration has a conflict target. */
  @Index('UQ_email_templates_label', { unique: true })
  @Column({ type: 'varchar', length: 120 })
  label!: string;

  /** A code from `EMAIL_TEMPLATE_PURPOSES`, stored as a plain varchar so a new
   *  purpose needs no migration. */
  @Column({ type: 'varchar', length: 40 })
  purpose!: EmailTemplatePurpose;

  @Column({ type: 'jsonb' })
  locales!: EmailTemplateLocales;

  @Column({ type: 'integer', default: 0 })
  sortOrder!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  // Actor FKs are nullable with ON DELETE SET NULL: a staff member leaving must
  // not take the library with them.
  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

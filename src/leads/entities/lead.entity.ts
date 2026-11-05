import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';
import {
  DEFAULT_LEAD_STAGE,
  type LeadStage,
  type LeadType,
} from '../leads.constants';

/**
 * Leads: one act, venue or business staff want to bring onto the platform,
 * kept in the shared directory at `admin/leads`. A staff-only table: every
 * field stays on the `admin/leads` routes and none reaches a member surface.
 *
 * `links` holds the trimmed links as typed, in submitted order; their link
 * keys (`leadLinkKey`) are compared in the service, so the table carries no
 * index on them. `email` is stored trimmed and lowercased, unique when set.
 * `follow_up_on` is a calendar day read in `LEAD_TIME_ZONE`, handed back as
 * `YYYY-MM-DD` text.
 *
 * The key to `subprofiles` cascades on update, so a pseudonym unlink rekey
 * carries `linked_subprofile_id` to the fresh id until
 * `forgetLeadLinkOfPersona` nulls it in the same transaction. A deleted
 * persona sets it null. Migration `1839300000000-AddLeads`.
 */
@Entity('leads')
@Unique('UQ_leads_linked_subprofile', ['linkedSubprofileId'])
@Index('UQ_leads_email', ['email'], {
  unique: true,
  where: '"email" IS NOT NULL',
})
@Index('IDX_leads_stage', ['stage'])
@Index('IDX_leads_follow_up_on', ['followUpOn'], {
  where: '"follow_up_on" IS NOT NULL',
})
@Index('IDX_leads_created_by_id', ['createdById'], {
  where: '"created_by_id" IS NOT NULL',
})
@Check('CHK_leads_name', `char_length(btrim("name")) >= 1`)
@Check(
  'CHK_leads_type',
  `"type" IN ('artist', 'dj', 'band', 'venue', 'promoter', 'collective', 'business', 'other')`,
)
@Check(
  'CHK_leads_stage',
  `"stage" IN ('to_contact', 'contacted', 'in_talks', 'on_board', 'not_now')`,
)
@Check('CHK_leads_email', `"email" IS NULL OR "email" = lower(btrim("email"))`)
@Check(
  'CHK_leads_links',
  `CASE WHEN jsonb_typeof("links") = 'array' THEN jsonb_array_length("links") <= 12 ELSE false END`,
)
export class Lead {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_leads' })
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 20 })
  type!: LeadType;

  @Column({ type: 'varchar', length: 20, default: DEFAULT_LEAD_STAGE })
  stage!: LeadStage;

  @Column({ type: 'varchar', length: 120, nullable: true })
  location!: string | null;

  @Column({ type: 'varchar', length: 254, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  links!: string[];

  /** `YYYY-MM-DD`; TypeORM hands a `date` column back as a string. */
  @Column({ type: 'date', nullable: true })
  followUpOn!: string | null;

  @Column({ type: 'uuid', nullable: true })
  linkedSubprofileId!: string | null;

  @ManyToOne(() => Subprofile, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({
    name: 'linked_subprofile_id',
    foreignKeyConstraintName: 'FK_leads_linked_subprofile',
  })
  linkedSubprofile?: Subprofile | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_id',
    foreignKeyConstraintName: 'FK_leads_created_by',
  })
  createdBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

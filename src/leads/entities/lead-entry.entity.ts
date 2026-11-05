import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';
import type { LeadEntryKind, LeadStage } from '../leads.constants';
import { Lead } from './lead.entity';

/**
 * Leads: one dated row on a lead's entry log. `note` rows carry a `body` and
 * are the only rows that change after insert (edit sets `edited_at`, delete
 * removes the row). `stage_changed` rows carry `from_stage` and `to_stage`,
 * `created` carries the starting stage in `to_stage`, and `persona_linked` /
 * `persona_unlinked` carry `subprofile_id` until a pseudonym unlink nulls it.
 *
 * `created_at` defaults to `clock_timestamp()`, so the entries one
 * transaction writes keep their insert order. The decorator lists the columns
 * of `IDX_lead_entries_lead_created_at` (`lead_id`, `created_at`, `id`) and
 * the migration holds their DESC order, since the decorator API cannot
 * express it. A deleted lead takes its entries with it;
 * a deleted account leaves its entries with no author. Migration
 * `1839300000000-AddLeads`.
 */
@Entity('lead_entries')
@Index('IDX_lead_entries_lead_created_at', ['leadId', 'createdAt', 'id'])
@Index('IDX_lead_entries_subprofile_id', ['subprofileId'], {
  where: '"subprofile_id" IS NOT NULL',
})
@Index('IDX_lead_entries_author_id', ['authorId'], {
  where: '"author_id" IS NOT NULL',
})
@Check(
  'CHK_lead_entries_kind',
  `"kind" IN ('note', 'stage_changed', 'persona_linked', 'persona_unlinked', 'created')`,
)
@Check('CHK_lead_entries_note_body', `("kind" = 'note') = ("body" IS NOT NULL)`)
@Check(
  'CHK_lead_entries_body_length',
  `"body" IS NULL OR char_length("body") <= 4000`,
)
@Check(
  'CHK_lead_entries_from_stage',
  `"from_stage" IS NULL OR "from_stage" IN ('to_contact', 'contacted', 'in_talks', 'on_board', 'not_now')`,
)
@Check(
  'CHK_lead_entries_to_stage',
  `"to_stage" IS NULL OR "to_stage" IN ('to_contact', 'contacted', 'in_talks', 'on_board', 'not_now')`,
)
@Check('CHK_lead_entries_edited_note', `"edited_at" IS NULL OR "kind" = 'note'`)
export class LeadEntry {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_lead_entries',
  })
  id!: string;

  @Column({ type: 'uuid' })
  leadId!: string;

  @ManyToOne(() => Lead, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'lead_id',
    foreignKeyConstraintName: 'FK_lead_entries_lead',
  })
  lead?: Lead;

  @Column({ type: 'varchar', length: 20 })
  kind!: LeadEntryKind;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  fromStage!: LeadStage | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  toStage!: LeadStage | null;

  @Column({ type: 'uuid', nullable: true })
  subprofileId!: string | null;

  @ManyToOne(() => Subprofile, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_lead_entries_subprofile',
  })
  subprofile?: Subprofile | null;

  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'author_id',
    foreignKeyConstraintName: 'FK_lead_entries_author',
  })
  author?: User | null;

  @CreateDateColumn({
    type: 'timestamptz',
    default: () => 'clock_timestamp()',
  })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  editedAt!: Date | null;
}

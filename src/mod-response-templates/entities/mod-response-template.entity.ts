import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ReasonCode } from '../../reports/reason-catalogue';
import type { ModActionCode } from '../../moderation/dto/mod-action.dto';

/**
 * One reusable, admin-authored member-facing explanation a moderator can
 * prefill into `ModActionDto.note`.
 *
 * WHY THIS TABLE EXISTS. `note` is required on every moderation action and is
 * the exact text the member reads. Typed fresh on every decision it is the
 * step that gets skipped at volume, which produces exactly the unexplained
 * enforcement the notification pipeline was built to prevent (the community
 * dismiss path already sends an empty string rather than face it).
 *
 * WHAT IT IS NOT. A template is never referenced by a stored action. The
 * frontend resolves the placeholders, the moderator edits the result, and the
 * approved text is what gets persisted on the action. Editing or deleting a
 * template therefore cannot rewrite history.
 *
 * KEYING. `reasonCode` and `actionCode` narrow when a template is offered.
 * NULL in either column means "fits any", so a general-purpose closing note
 * lives as one row instead of being duplicated across the whole taxonomy.
 * Both are plain varchars, matching how `reports.reason_code` is stored: the
 * taxonomies are TypeScript unions (`REASON_CODES`, `MOD_ACTION_CODES`), not
 * Postgres enums, and adding a code should not need a migration here.
 */
@Entity('mod_response_templates')
// Serves the moderator read: active rows, narrowed by the reason currently
// selected in the drawer. `actionCode` is left out of the index because the
// table is small (tens of rows) and the reason filter is the selective one.
@Index('IDX_mod_response_templates_active_reason', ['isActive', 'reasonCode'])
export class ModResponseTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Short moderator-facing name, e.g. "Harassment: first warning". Never shown
   * to the member. Unique, so a picker row is identifiable at a glance and so
   * the starter-set data migration has a conflict target to be idempotent on.
   */
  @Index('UQ_mod_response_templates_label', { unique: true })
  @Column({ type: 'varchar', length: 120 })
  label!: string;

  /** The member-facing text, with `{member}` / `{community}` placeholders.
   *  Capped at 2000 to match `ModActionDto.note`'s `@MaxLength(2000)`, so a
   *  template can never prefill a note the action endpoint would reject. */
  @Column({ type: 'text' })
  body!: string;

  /** The reason this template is keyed to, or NULL for "fits any reason". */
  @Column({ type: 'varchar', length: 40, nullable: true })
  reasonCode!: ReasonCode | null;

  /** The action this template suits, or NULL for "fits any action". */
  @Column({ type: 'varchar', length: 40, nullable: true })
  actionCode!: ModActionCode | null;

  /** Ascending display order within a filtered set. Ties broken by `label`. */
  @Column({ type: 'integer', default: 0 })
  sortOrder!: number;

  /** Deactivated templates stay in the table (so an admin can bring one back)
   *  and disappear from the moderator picker. */
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  // Nullable with `ON DELETE SET NULL`, the actor-FK convention: a staff
  // member leaving the platform must not take the response library with them.
  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

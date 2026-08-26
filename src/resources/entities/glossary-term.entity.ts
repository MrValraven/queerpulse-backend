import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A single glossary entry (the frontend's `GlossaryPage`/`glossary.data.tsx`
 * — one flattened English-language entry per FE `Term`; the FE's PT
 * translations and inline `meta` cross-reference links are presentation-only
 * and intentionally not persisted, per the "no presentation fields" rule).
 *
 * Writable since CON-08 via `AdminGlossaryController` — the page claims the
 * glossary is maintained by Trans Hub and Wellbeing, and this is the
 * mechanism that makes that true.
 */
@Entity('glossary_terms')
export class GlossaryTerm {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_glossary_terms_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  term!: string;

  @Column({ type: 'text' })
  definition!: string;

  // Portuguese definition. NULL means "no translation yet" — the frontend
  // falls back to the English text rather than showing a blank entry.
  @Column({ type: 'text', nullable: true })
  definitionPt!: string | null;

  // Free-form category label (mirrors the FE's `Term.type`, e.g. "Identity",
  // "Healthcare", "Lisbon" — nullable because a handful of FE entries carry
  // no `type` at all).
  @Index('IDX_glossary_terms_category')
  @Column({ type: 'varchar', nullable: true })
  category!: string | null;

  // Editorial review (CON-09), same three fields the guide record carries.
  @Index('IDX_glossary_terms_review_due_on')
  @Column({ type: 'date', nullable: true })
  reviewDueOn!: string | null;

  @Column({ type: 'date', nullable: true })
  lastReviewedOn!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  reviewedBy!: string | null;

  // Staff account that last wrote this row. No FK, for the same reason as
  // `Resource.updatedBy`.
  @Column({ type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

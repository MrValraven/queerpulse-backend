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
 * Read-only + seeded; no authoring endpoint.
 */
@Entity('glossary_terms')
export class GlossaryTerm {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_glossary_terms_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar' })
  term: string;

  @Column({ type: 'text' })
  definition: string;

  // Free-form category label (mirrors the FE's `Term.type`, e.g. "Identity",
  // "Healthcare", "Lisbon" — nullable because a handful of FE entries carry
  // no `type` at all).
  @Index('IDX_glossary_terms_category')
  @Column({ type: 'varchar', nullable: true })
  category: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

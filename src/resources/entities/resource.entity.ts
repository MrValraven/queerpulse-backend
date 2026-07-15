import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A single editorial resource guide (the frontend's `LibraryPage`/guide
 * pages — housing, health, legal, finance, trans-life). Read-only + seeded;
 * there is no authoring endpoint (out of scope per the design doc's Tier 5
 * note: "Authoring/admin CRUD for editorial content is out of scope").
 */
@Entity('resources')
export class Resource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_resources_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  // Free-form category key (mirrors the FE's `library.data.ts` `CATEGORIES`
  // ids: "housing" | "health" | "legal" | "finance" | "trans" — kept as a
  // plain varchar rather than an enum since the guide library is expected to
  // grow new categories without a schema migration).
  @Index('IDX_resources_category')
  @Column({ type: 'varchar' })
  category: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', nullable: true })
  externalUrl: string | null;

  // NULL (or a future date) hides the resource from the public list/detail
  // endpoints — mirrors `Partner.status !== approved` gating: existence of
  // an unpublished resource is a 404, not a distinct "not visible yet" body.
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * The three frontend features this generic CMS serves — `culture`, `support`,
 * and `governance` — are demo-only React features (mock data, no `*.api.ts`)
 * that render slug-addressable prose content. `topics` is handled separately
 * (see `entities/topic.entity.ts`): it's an interest/forum directory, not a
 * prose page, so it doesn't belong in this enum.
 */
export enum ContentSection {
  Culture = 'culture',
  Support = 'support',
  Governance = 'governance',
}

/**
 * A single slug-addressable content page, shaped 1:1 to the frontend's
 * `PageResponse` contract (`queerpulse/src/shared/contracts/contracts.ts`).
 * `(section, slug)` is the natural key; `id` stays a synthetic uuid so every
 * entity in this codebase gets one, mirroring `Partner`/`Event`.
 *
 * Read-only from the API's perspective: pages are seeded (see
 * `../content.seed.ts`) and there is no authoring/admin CRUD in this phase
 * (out of scope per the connect-frontend spec — "Authoring/admin CRUD for
 * editorial content is out of scope (seed + read only)").
 */
@Entity('content_pages')
@Index('UQ_content_pages_section_slug', ['section', 'slug'], { unique: true })
export class ContentPage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: ContentSection,
    enumName: 'content_pages_section_enum',
  })
  section: ContentSection;

  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', default: 'en' })
  locale: string;

  // Nullable: a null (or future-dated) `publishedAt` hides the page from both
  // list and by-slug reads (see `ContentPagesService`) — the same
  // draft/scheduled-publish convention as `Event`'s `status` column, kept
  // minimal here as a single timestamp rather than a full status enum since
  // there's no authoring flow yet to move a page between states.
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

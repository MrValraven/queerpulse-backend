import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GuideSection } from '../guide-section';

/**
 * A single editorial resource guide (the frontend's guide library and the
 * ~31 `/resources/*` guide pages — health, legal, trans life, safety,
 * community, culture, finance).
 *
 * Writable since CON-08: `AdminResourcesController` is the authoring
 * endpoint, so changing a phone number in a crisis guide is an editor typing
 * in the admin panel rather than an engineer editing two i18n catalogs and
 * shipping a deploy. `sections`/`sectionsPt` carry the prose (see
 * `guide-section.ts`); a row whose `sections` is empty is metadata-only and
 * the frontend keeps rendering that guide's hardcoded page.
 */
@Entity('resources')
export class Resource {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_resources_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  // Free-form category key (mirrors the FE's `library.data.ts` `CATEGORIES`
  // ids: "housing" | "health" | "legal" | "finance" | "trans" — kept as a
  // plain varchar rather than an enum since the guide library is expected to
  // grow new categories without a schema migration).
  @Index('IDX_resources_category')
  @Column({ type: 'varchar' })
  category!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text' })
  description!: string;

  // Legacy single-blob body, kept for the rows and search paths that predate
  // `sections`. New authoring writes `sections`; `body` stays as a plain-text
  // summary so the search index and any older consumer keep working.
  @Column({ type: 'text' })
  body!: string;

  // Portuguese title/description. NULL means "no translation yet" — the
  // frontend falls back to the English copy rather than showing a blank.
  @Column({ type: 'varchar', nullable: true })
  titlePt!: string | null;

  @Column({ type: 'text', nullable: true })
  descriptionPt!: string | null;

  // The structured, editor-authored prose. An EMPTY array is meaningful: it
  // says this guide is not managed yet and the frontend must keep its
  // hardcoded page (see `guide-section.ts`).
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  sections!: GuideSection[];

  // Portuguese sections. NULL (not an empty array) means "never translated";
  // the renderer falls back to `sections`.
  @Column({ type: 'jsonb', nullable: true })
  sectionsPt!: GuideSection[] | null;

  // The frontend path this guide is addressable at (e.g.
  // "/resources/spoon-theory"). Replaces the old title-string lookup the
  // library grid used to guess a link with — a guess that silently bounced
  // the reader back to the library whenever a title stopped matching.
  @Column({ type: 'varchar', nullable: true })
  routePath!: string | null;

  // Short card-footer chip the FE's `library.data.ts` `Guide.meta` renders
  // (e.g. "Guide · 12 min · PT / EN") — format, read time, language
  // availability. Nullable so older/unauthored rows degrade gracefully.
  @Column({ type: 'varchar', nullable: true })
  meta!: string | null;

  @Column({ type: 'varchar', nullable: true })
  externalUrl!: string | null;

  // NULL (or a future date) hides the resource from the public list/detail
  // endpoints — mirrors `Partner.status !== approved` gating: existence of
  // an unpublished resource is a 404, not a distinct "not visible yet" body.
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  // When an editor last confirmed this guide's information (phone numbers,
  // eligibility rules, statute references, clinic hours, …) is still
  // accurate. NULL means never verified — the FE shows an honest "not yet
  // verified" state rather than a fabricated date. Set by hand during
  // editorial review; there is no automated re-verification sweep yet.
  @Column({ type: 'timestamptz', nullable: true })
  lastVerifiedAt!: Date | null;

  // ── Editorial review (CON-09) ─────────────────────────────────────────
  // Health guidance rots. `lastReviewedOn` is the date an editor last read
  // the guide end to end, `reviewedBy` is who that was (a person or a team
  // name, free text — a staff account can be deleted and the audit trail
  // must outlive it), and `reviewDueOn` is when it should be read again.
  // All three NULL means never reviewed, which the reader footer states
  // plainly rather than inventing a date.
  @Index('IDX_resources_review_due_on')
  @Column({ type: 'date', nullable: true })
  reviewDueOn!: string | null;

  @Column({ type: 'date', nullable: true })
  lastReviewedOn!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  reviewedBy!: string | null;

  // Staff account that last wrote this row. No FK: an audit trail that must
  // outlive a deleted staff account (mirrors `ResourceListing.updatedBy`).
  @Column({ type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

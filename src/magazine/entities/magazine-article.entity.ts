import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Mirrors the frontend `ArticleBlock` union (`queerpulse/.../mag-write.jsx`
 * "ArticleBlock union" comment). Stored verbatim as jsonb on
 * `MagazineArticle.blocks`; validated in the service (see
 * `magazine-article-blocks.validation.ts`), never by the ORM or TypeORM
 * decorators.
 */
export type ArticleBlock =
  | { id: string; kind: 'paragraph'; html: string; lead?: boolean }
  | { id: string; kind: 'heading'; html: string }
  | { id: string; kind: 'pullQuote'; html: string }
  | { id: string; kind: 'quote'; html: string; cite: string }
  | {
      id: string;
      kind: 'image';
      alt: string;
      caption: string;
      credit: string;
      rights: 'commissioned' | 'licensed' | 'courtesy' | 'cc';
      tint: 'coral' | 'jade' | 'plum' | 'violet';
      crop: '16:9' | '4:5' | '1:1';
      focal: { x: number; y: number };
      src?: string;
    }
  | { id: string; kind: 'qa'; q: string; html: string; who: string }
  | {
      id: string;
      kind: 'stats';
      items: { value: string; label: string }[];
    };

/**
 * A published magazine piece (`ArticlePage.tsx` / `data/articles.tsx`). Links
 * to its byline (`authorId` -> `magazine_author`) and, optionally, the issue
 * it ran in (`issueId` -> `magazine_issue`; nullable — a piece can be
 * web-only). Maps to `ArticleListItem`/`ArticleResponse` in contracts.ts.
 */
@Entity('magazine_article')
export class MagazineArticle {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_magazine_article_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text' })
  dek!: string;

  @Column({ type: 'varchar', default: '' })
  standfirst!: string;

  @Column({ type: 'varchar', default: '' })
  kicker!: string;

  @Column({ type: 'varchar', default: '' })
  section!: string;

  /** The contributor's credit-line qualifier (e.g. "Contributing editor"),
   * mirroring `MagazineDeck.role`. */
  @Column({ type: 'varchar', default: '' })
  role!: string;

  /** SEO/social fields (added alongside `role` — no equivalent existed
   * before this). All optional, default `''`. */
  @Column({ type: 'varchar', default: '' })
  metaDescription!: string;

  @Column({ type: 'varchar', default: '' })
  socialImage!: string;

  @Column({ type: 'varchar', default: '' })
  canonicalUrl!: string;

  /** Legacy plain-text body, retained but superseded by `blocks`. */
  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'text', array: true, default: '{}' })
  contentNotes!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  blocks!: ArticleBlock[];

  @Index('IDX_magazine_article_author_id')
  @Column({ type: 'uuid' })
  authorId!: string;

  @Index('IDX_magazine_article_issue_id')
  @Column({ type: 'uuid', nullable: true })
  issueId!: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  tags!: string[];

  @Column({ type: 'int' })
  readMinutes!: number;

  /**
   * Optimistic-concurrency counter for the draft body, bumped by every write
   * that can change what an editor is looking at (`updateArticleDraft`, the
   * writer's `fileDraft` block append, `restoreArticleVersion`).
   *
   * The article editor autosaves partial patches, `blocks` included, and the
   * desk is deliberately MULTI-ACTOR: the assigned writer files into the same
   * row an editor is editing, and a sensitivity reader may have a third tab
   * open. Without a precondition those writes are last-write-wins on a whole
   * `blocks` array — one autosave silently discards the other's paragraphs, and
   * a stale tab autosaving after a "Restore version" quietly undoes the
   * restore. Autosaves are not snapshotted, so what is lost is unrecoverable.
   *
   * NOT `@VersionColumn`: TypeORM increments that on every `save()` but never
   * adds the `WHERE version = :expected` predicate, so it would read like a
   * guarantee while providing none. The counter is bumped explicitly by the
   * one guarded write path (see `MagazinePieceService.saveArticleDraftGuarded`)
   * which does the conditional UPDATE itself.
   */
  @Column({ type: 'int', default: 0 })
  version!: number;

  /** Doubles as the schedule instant: every public read gates on
   *  `published_at IS NOT NULL AND published_at <= now()` and orders by it
   *  descending, which is exactly the shape of the partial index below
   *  (`IDX_magazine_article_published_at`, added CONCURRENTLY in its own
   *  migration). Drafts are excluded from the index — no public query wants
   *  them and a working desk accumulates a lot of them. */
  @Index('IDX_magazine_article_published_at')
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

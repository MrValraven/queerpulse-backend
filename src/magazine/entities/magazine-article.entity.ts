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
 * CON-16 — the lifecycle states a published piece can be in. See
 * `MagazineArticle.lifecycle` for what each one promises the reader.
 */
export type ArticleLifecycle =
  'live' | 'under_review' | 'archived' | 'superseded';

export const ARTICLE_LIFECYCLES: readonly ArticleLifecycle[] = [
  'live',
  'under_review',
  'archived',
  'superseded',
] as const;

/**
 * CON-16 — the languages the magazine publishes in. Mirrors the frontend's
 * `Language` union (`shared/i18n/types.ts`), so a reader's chosen chrome
 * language is directly usable as a content locale.
 */
export type ArticleLocale = 'en' | 'pt';

export const ARTICLE_LOCALES: readonly ArticleLocale[] = ['en', 'pt'] as const;

/** The locale every pre-translation article is written in. */
export const DEFAULT_ARTICLE_LOCALE: ArticleLocale = 'en';

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

  /**
   * CON-04 — the piece's lead art: the storage key of the hero photograph or
   * illustration an editor commissioned for it, `''` when none is set.
   *
   * The magazine had no image column at all before this, so every card in live
   * mode rendered a tinted `ImageSlot` placeholder and every article's hero
   * strip was an empty tint. `socialImage` was NOT that column: it is the SEO
   * rail's share-card override (`og:image`), which an editor may point at a
   * differently-cropped file or leave blank entirely, and reading it as the
   * page's art conflated two separate editorial decisions.
   *
   * A storage key, exactly like `MagazineStorySubmission.coverImageKey`: the
   * write DTO accepts either the bare key or our own resolved `/files/<key>`
   * URL (the global `StorageKeyOwnershipInterceptor` collapses the latter back
   * to a key before the service sees it), and every read maps it out through
   * `toImageUrl`. Its reframe crop is NOT a column here — it lives in
   * `media_crop`, keyed by this storage key, like every other reframed upload
   * in the app, and the reads join it in via `MediaCropService.getMany`.
   */
  @Column({ type: 'varchar', default: '' })
  heroImageKey!: string;

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

  /**
   * CON-12 — the magazine's own free-text search index. A STORED generated
   * `tsvector` over `title` (weight A), `dek`/`standfirst`/`tags` (B) and both
   * body representations, the legacy `body` text and the block-editor `blocks`
   * jsonb flattened by `magazine_article_blocks_text()` (D). Postgres computes
   * it on every write; nothing in the application ever assigns it, hence
   * `insert`/`update: false` (a write would fail: the column is GENERATED
   * ALWAYS). `select: false` keeps it out of every existing `find`, so no read
   * path starts hauling a whole article's lexemes around.
   *
   * Declared here only so a `migration:generate` diff does not propose
   * dropping a column the schema really has. The queries that use it
   * (`MagazineService.listArticles`'s `?q=` and `searchByText`) reference the
   * raw `article.search_vector` column in SQL, because `@@` and `ts_rank_cd`
   * have no query-builder equivalent.
   *
   * Added by `1794833600000-AddMagazineArticleSearchVector`; the GIN index
   * that serves it is built CONCURRENTLY in `1794833610000-...Index`.
   */
  @Column({
    type: 'tsvector',
    select: false,
    insert: false,
    update: false,
    nullable: true,
  })
  searchVector?: string;

  /**
   * CON-16 — where a published piece stands TODAY, independent of whether it
   * is published at all.
   *
   * `published_at` answers "is this visible?" and nothing else, so the only
   * way to retire a piece was to unpublish it, which also deletes it from the
   * archive and breaks every link anyone ever shared. For a magazine that
   * covers legal rights, healthcare access and organisations that reorganise,
   * "live or gone" is the wrong pair of options: the honest answer is usually
   * "still here, still readable, and here is what has changed since".
   *
   * The four states, and what each one promises the reader:
   *  - `live` — current. The desk stands by it as written.
   *  - `under_review` — the desk is re-checking it against the law or the
   *    service as they stand now. Parts may already be out of date. This is
   *    where a piece lands when its `reviewDueOn` comes round and an editor
   *    opens it; it is a state a piece LEAVES, back to `live` or on to
   *    `archived`/`superseded`.
   *  - `archived` — of its time. Kept because it is a record of what was
   *    true then, no longer maintained, and read as history.
   *  - `superseded` — a newer piece replaces it. `supersededByArticleId`
   *    names that piece so the banner can send the reader straight there.
   *
   * Never a reason to hide a row: every public read still returns archived
   * and superseded pieces, and the reader gets a dated banner instead of a
   * 404. See `ArticleLifecycleResponse` / `ArticleLifecycleBanner`.
   */
  @Index('IDX_magazine_article_lifecycle')
  @Column({ type: 'varchar', length: 24, default: 'live' })
  lifecycle!: ArticleLifecycle;

  /** The editor's own sentence for the banner ("The name-change process
   *  changed in March 2026; the section on documents no longer applies").
   *  Empty means the banner falls back to the generic wording for the state,
   *  which is honest but says less. Plain text. */
  @Column({ type: 'varchar', length: 500, default: '' })
  lifecycleNote!: string;

  /** When the piece last entered its current lifecycle state. This is the
   *  DATE in "dated banner" — the reader is told when the desk last looked,
   *  never left to infer it from the publish date. NULL for a piece that has
   *  never left `live`. */
  @Column({ type: 'timestamptz', nullable: true })
  lifecycleChangedAt!: Date | null;

  /** The scheduled re-review: the day the desk has promised itself it will
   *  look at this piece again. Drives the review queue on the lifecycle desk.
   *  A `date`, not a timestamp — "re-check in six months" has no clock time.
   *  NULL for a piece with no standing promise. */
  @Index('IDX_magazine_article_review_due_on')
  @Column({ type: 'date', nullable: true })
  reviewDueOn!: string | null;

  /** The piece that replaces this one, when `lifecycle` is `superseded`.
   *  `ON DELETE SET NULL`: deleting the replacement leaves this piece
   *  superseded-with-no-target rather than cascading a delete through the
   *  archive, and the banner degrades to its note. */
  @Column({ type: 'uuid', nullable: true })
  supersededByArticleId!: string | null;

  /**
   * CON-16 — the language this piece is WRITTEN IN. `'en'` for everything
   * that existed before translations, which is truthful: the archive was
   * entirely English.
   *
   * This is deliberately NOT the i18n catalog mechanism. Chrome strings live
   * in the catalogs and are translated there; journalism gets its own row,
   * its own slug, its own byline and its own editorial history, because a
   * translated article is a piece of work by a named person, not a value in
   * a key-value file.
   */
  @Column({ type: 'varchar', length: 8, default: 'en' })
  locale!: ArticleLocale;

  /**
   * The article this one is a translation OF, or NULL when this is an
   * original. A translation is a first-class article: its own row, slug,
   * publish state, lifecycle and comments. This column is the only thing that
   * makes it a sibling rather than a duplicate.
   *
   * Browse lists filter to `translation_of_article_id IS NULL` so the archive
   * shows each piece once and the reader's language choice picks which
   * version they get. Free-text search does NOT, because a Portuguese query
   * can only ever match Portuguese text.
   *
   * A partial unique index over (`translation_of_article_id`, `locale`) keeps
   * one translation per language per original.
   */
  @Index('IDX_magazine_article_translation_of')
  @Column({ type: 'uuid', nullable: true })
  translationOfArticleId!: string | null;

  /**
   * The byline of the person who translated this piece. The `authorId` on a
   * translation stays the ORIGINAL writer: they wrote it, and the reader
   * should see their name. The translator is a second contributor and gets
   * their own credit line ("Translated by ..."), which is also why this
   * points at `magazine_author` and not at a free-text name.
   */
  @Column({ type: 'uuid', nullable: true })
  translatorAuthorId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

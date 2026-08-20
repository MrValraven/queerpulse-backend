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

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

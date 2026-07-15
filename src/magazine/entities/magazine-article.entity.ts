import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A published magazine piece (`ArticlePage.tsx` / `data/articles.tsx`). Links
 * to its byline (`authorId` -> `magazine_author`) and, optionally, the issue
 * it ran in (`issueId` -> `magazine_issue`; nullable — a piece can be
 * web-only). Maps to `ArticleListItem`/`ArticleResponse` in contracts.ts.
 */
@Entity('magazine_article')
export class MagazineArticle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_magazine_article_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text' })
  dek: string;

  @Column({ type: 'text' })
  body: string;

  @Index('IDX_magazine_article_author_id')
  @Column({ type: 'uuid' })
  authorId: string;

  @Index('IDX_magazine_article_issue_id')
  @Column({ type: 'uuid', nullable: true })
  issueId: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ type: 'int' })
  readMinutes: number;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A threaded, resolvable comment anchored to a `MagazineArticle` (Magazine
 * Desk Phase 7, Task D1 — the editor/writer NotesRail). `blockId` optionally
 * anchors the comment to one `ArticleBlock.id` on the article (see
 * `magazine-article.entity.ts`); `null` means a general, whole-article note.
 * `parentId` is `null` for a top-level comment and the top-level comment's
 * `id` for a reply — threading is one level deep by convention (a reply
 * always targets a top-level comment, never another reply), enforced by the
 * service (`replyToArticleComment`), not by the schema.
 */
@Entity('magazine_article_comment')
export class MagazineArticleComment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_magazine_article_comment_article')
  @Column({ type: 'uuid' })
  articleId!: string;

  @Column({ type: 'varchar', nullable: true })
  blockId!: string | null;

  @Index('IDX_magazine_article_comment_parent')
  @Column({ type: 'uuid', nullable: true })
  parentId!: string | null;

  @Column({ type: 'uuid' })
  authorId!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'boolean', default: false })
  resolved!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

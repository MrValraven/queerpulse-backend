import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A public reader's comment on a published `MagazineArticle` (CNT-10) — NOT
 * `MagazineArticleComment` (the staff-only, block-anchored editorial
 * NotesRail; see that entity's docstring). `parentId` is `null` for a
 * top-level comment and the top-level comment's `id` for a reply — one level
 * deep only (a reply always targets a top-level comment, never another
 * reply), enforced by `MagazineReaderCommentsService.create`, not the schema.
 * Soft-tombstone on delete (`deletedAt` set) mirrors `ForumPost.deletedAt`:
 * the row survives so a reply thread never orphans, and the read path blanks
 * `body`/author instead of physically deleting.
 */
@Entity('magazine_reader_comment')
export class MagazineReaderComment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_magazine_reader_comment_article_id')
  @Column({ type: 'uuid' })
  articleId!: string;

  @Index('IDX_magazine_reader_comment_parent_id')
  @Column({ type: 'uuid', nullable: true })
  parentId!: string | null;

  @Index('IDX_magazine_reader_comment_author_id')
  @Column({ type: 'uuid' })
  authorId!: string;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}

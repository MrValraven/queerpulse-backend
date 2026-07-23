import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A single post within a thread. The oldest post (by `createdAt`) for a
 * given `threadId` is the thread's OP; every later one is a reply — there is
 * no `kind`/`isOp` column, the ordering *is* the distinction (see
 * `ForumPostsService.listPosts`'s oldest-first cursor page).
 */
@Entity('forum_post')
export class ForumPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_forum_post_thread_id')
  @Column({ type: 'uuid' })
  threadId: string;

  @Index('IDX_forum_post_author_id')
  @Column({ type: 'uuid' })
  authorId: string;

  @Column({ type: 'text' })
  body: string;

  // Denormalized count of `forum_post_vote` rows with `value = 1` for this
  // post, kept in sync by `ForumPostsService.vote` — avoids a `COUNT(*)`
  // join on every post render.
  @Column({ type: 'int', default: 0 })
  voteCount: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  editedAt: Date | null;

  // Soft-tombstone marker. When set, the post renders as "[deleted]" but the
  // `body` above is preserved so an author/moderator can restore it and its
  // edit history stays readable (see `ForumPostsService.tombstonePost`).
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}

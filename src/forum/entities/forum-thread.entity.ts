import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A forum thread's metadata. Its opening post (the "OP") is *not* stored
 * here — it's the oldest `ForumPost` row for this thread (see
 * `ForumThreadsService.create`, which inserts both in one transaction).
 * Table name is singular (`forum_thread`) per the task brief, not pluralized
 * like `communities`/`community_posts`.
 */
@Entity('forum_thread')
export class ForumThread {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  slug: string;

  @Column({ type: 'varchar' })
  title: string;

  @Index('IDX_forum_thread_author_id')
  @Column({ type: 'uuid' })
  authorId: string;

  @Index('IDX_forum_thread_category')
  @Column({ type: 'varchar' })
  category: string;

  @Column({ type: 'boolean', default: false })
  isPinned: boolean;

  @Column({ type: 'boolean', default: false })
  isLocked: boolean;

  // Count of *replies* only — the OP itself isn't counted (mirrors the
  // frontend's `ForumThreadResponse.replyCount`, which the thread list/detail
  // cards render next to a distinct "posts" affordance for the OP).
  @Column({ type: 'int', default: 0 })
  replyCount: number;

  // Set at creation, bumped to `now()` on every new reply
  // (`ForumThreadsService.markActivity`) — drives "recently active" sort in
  // the frontend, independent of `createdAt`.
  @Column({ type: 'timestamptz' })
  lastActivityAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

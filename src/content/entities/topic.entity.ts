import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A directory entry for one of the frontend's `topics` feature hashtags
 * (`queerpulse/src/features/topics/topics.data.tsx`). `topics` there is an
 * interest/forum directory (posts, top voices, related tags) rather than
 * prose CMS content, so it gets its own table instead of living in
 * `content_pages`. See the module-level note in `ContentSection`.
 *
 * This entity backs the directory list (`GET /topics`) and the topic-detail
 * read (`GET /topics/:slug`): the meta `TopicHeader`/`TopicSidebar` need
 * (name, description, follower/post counts, related topics). The per-topic
 * POST FEED itself (`Topic.posts` in the mock) has its own table,
 * `topic_post.entity.ts`. See that file's docstring for why it is a
 * dedicated table rather than an aggregation over forum/community/event
 * rows. `topVoices` and the curated `resources` panel remain out of scope
 * (no backend shape requested for those; the frontend keeps them demo-only
 * in live mode too, a documented gap rather than a fake success).
 *
 * WHERE THE ROWS COME FROM (SOC-01). The curated starter directory is
 * inserted by `SeedTopics1794701000000` from `src/topics/topics.seed.ts`, in
 * every environment including production. Everything after that is written by
 * the operating team through `admin-topics` (`AdminTopicsController`). There
 * is no `content.seed.ts` on disk and there never was one for this table;
 * older migration comments that name it are describing an intent that was
 * never committed.
 */
@Entity('topics')
export class Topic {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_topics_tag', { unique: true })
  @Column({ type: 'varchar' })
  tag!: string;

  /** Plain-text label (the mock's JSX-composed serif heading, flattened). */
  @Column({ type: 'varchar' })
  label!: string;

  /** Plain-text summary (the mock's JSX `sub`, flattened, links stripped). */
  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'int', default: 0 })
  totalPosts!: number;

  /**
   * "Members following" on `TopicHeader`'s stat row. A denormalized counter
   * rather than a join: `topic_follows` is slug-keyed and carries no FK to
   * this table, and this number is read on every topic page load.
   *
   * `TopicFollowsService.follow`/`unfollow` maintain it (SOC-01), each write
   * guarded so a double-follow and a repeated unfollow both leave the count
   * where it belongs. It was unwritten before that, which is why a live topic
   * page read "0 following" forever.
   */
  @Column({ type: 'int', default: 0 })
  followerCount!: number;

  /** Whether the topic page should surface the crisis-support sidebar card. */
  @Column({ type: 'boolean', default: false })
  crisisCard!: boolean;

  /**
   * When the operating team retired this topic (SOC-01), or NULL while it is
   * live.
   *
   * Mapped as TypeORM's delete-date column, so every select on this entity
   * excludes archived rows without a hand-written predicate: the directory
   * list, `loadOr404`, the related-topics panel and the search fan-out all go
   * through `find`/`createQueryBuilder` here. `AdminTopicsService` passes
   * `withDeleted` to see them, and restoring clears the column.
   *
   * Declared optional rather than with the definite-assignment `!` every other
   * column here carries: the ORM writes it on the soft-delete path only, and a
   * `Topic` object literal built by hand (a test fixture, a `create()` call)
   * has no business naming a column that means "archived" just to say the
   * topic is live.
   */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  archivedAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

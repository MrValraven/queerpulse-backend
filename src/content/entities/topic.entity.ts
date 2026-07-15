import {
  Column,
  CreateDateColumn,
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
 * `content_pages` — see the module-level note in `ContentSection`.
 *
 * This entity backs the directory list (`GET /topics`) and the topic-detail
 * read (`GET /topics/:slug`) — the meta `TopicHeader`/`TopicSidebar` need
 * (name, description, follower/post counts, related topics). The per-topic
 * POST FEED itself (`Topic.posts` in the mock) now has its own table,
 * `topic_post.entity.ts` — see that file's docstring for why it's a
 * dedicated table rather than an aggregation over forum/community/event
 * rows. `topVoices` and the curated `resources` panel remain out of scope
 * (no backend shape requested for those; the frontend keeps them demo-only
 * in live mode too — a documented gap, not a fake success).
 */
@Entity('topics')
export class Topic {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_topics_tag', { unique: true })
  @Column({ type: 'varchar' })
  tag: string;

  /** Plain-text label (the mock's JSX-composed serif heading, flattened). */
  @Column({ type: 'varchar' })
  label: string;

  /** Plain-text summary (the mock's JSX `sub`, flattened, links stripped). */
  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'int', default: 0 })
  totalPosts: number;

  /** "Members following" on `TopicHeader`'s stat row. There is no follow/
   *  unfollow endpoint in this task's scope (the frontend's "Follow topic"
   *  button is a toast-only demo affordance) — this is a denormalized
   *  counter seeded/maintained the same way `totalPosts` is, not derived
   *  from a join. */
  @Column({ type: 'int', default: 0 })
  followerCount: number;

  /** Whether the topic page should surface the crisis-support sidebar card. */
  @Column({ type: 'boolean', default: false })
  crisisCard: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

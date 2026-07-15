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
 * This entity backs only the directory list (`GET /topics`): the per-topic
 * post feed in the mock (`Topic.posts`, `topVoices`, `resources`, and title/sub
 * fields authored as JSX) is presentation-only demo content that doesn't
 * serialize to JSON and conceptually belongs to the forum/feed domain
 * (already covered elsewhere), not this generic content module — seeding it
 * here would overbuild a seed+read-only CMS. See the module report for the
 * full rationale.
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

  /** Whether the topic page should surface the crisis-support sidebar card. */
  @Column({ type: 'boolean', default: false })
  crisisCard: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

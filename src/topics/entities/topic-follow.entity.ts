import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

// A member "following" a topic — one row per (user, topicSlug). Topics have no
// backend table of their own (they are frontend-derived by tag/slug, served
// read-side by the `content` module's `TopicsController`), so the follow is
// keyed by the topic's public `slug` varchar rather than an FK to a topics
// table. Backs `GET /topics/follows` (the caller's followed slugs, used to seed
// the follow button's initial state).
//
// `UQ_topic_follows (user_id, topic_slug)` makes following idempotent at the DB
// level: a double-tap re-affirms the same row via `ON CONFLICT DO NOTHING`
// (`orIgnore()`) rather than raising 23505. The composite unique already leads
// with `user_id`, so it also serves the "which topics does THIS user follow?"
// lookup; `IDX_topic_follows_user_id` is kept as an explicit single-column
// index for that read (per the P2-15 spec).
@Entity('topic_follows')
@Unique('UQ_topic_follows', ['userId', 'topicSlug'])
export class TopicFollow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_topic_follows_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  topicSlug!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

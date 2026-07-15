import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One post in a topic's feed — backs the frontend's `TopicPage` /
 * `TopicFeed` / `TopicPostCard` (`queerpulse/src/features/topics/**`),
 * whose `Topic.posts: TopicPost[]` the original `topic.entity.ts` docstring
 * had deliberately left un-modeled ("conceptually belongs to the forum/feed
 * domain... not this generic content module"). Wiring the topic page for
 * real revisits that call:
 *
 * MODELING CHOICE — dedicated table, not an aggregation over
 * `forum_thread`/`community_post`/`event` by a shared tag column:
 * 1. The mock's post shape is genuinely heterogeneous per `kind` (asking,
 *    recommend, warn, article, event, thread) — an `article` post carries
 *    "284 reads · 26 bookmarks", an `event` post carries "14 spots left ·
 *    30-day streak", a `thread`/`recommend` post carries "42 relate · 18
 *    replies". None of the existing domain entities carry a `tags` column
 *    today (`ForumThread.category` is one string, `CommunityPost` has no
 *    kind/stat split, `Event` models RSVPs not free-text stats), so
 *    reusing them would mean adding a hashtag/tags column to four unrelated
 *    entities plus a `feed.service.ts`-style read-time merge across all of
 *    them — a much bigger, riskier change than this feature needs, and out
 *    of this task's scope (content module only; see the module report).
 * 2. `topics` / `content_pages` in this same module already established the
 *    "seed + read-only directory" pattern (see `topic.entity.ts`,
 *    `../content.seed.ts`) for exactly this kind of frontend-mock-derived
 *    read model — a dedicated `topic_post` table is the natural
 *    continuation of that pattern, not a new architecture.
 *
 * Presentation-only fields from the mock are kept as flattened display
 * strings (`contextLabel`, `reactionLabel`/`replyLabel`) — the same
 * "no bespoke JSX, just the flattened text" convention `Topic.label`/
 * `description` already use. The engagement numbers themselves
 * (`reactionCount`/`replyCount`) stay structured integers rather than a
 * single opaque "stats" string, since the frontend needs real counts.
 */
@Entity('topic_post')
export class TopicPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_topic_post_topic_id')
  @Column({ type: 'uuid' })
  topicId: string;

  @Column({ type: 'varchar' })
  authorName: string;

  @Column({ type: 'varchar' })
  authorInitials: string;

  /** The frontend's `AvatarTint` ('coral' | 'jade' | 'plum'). */
  @Column({ type: 'varchar' })
  authorTone: string;

  /** The segment of the mock's `meta` after the author line — a community
   *  name, a read time, or an event's schedule (e.g. "Trans Hub", "8 min
   *  read", "Thu 12 Jun, 19:00"). Deliberately not decomposed into
   *  structured time/location fields: it varies by `kind` in ways that
   *  don't share a schema (see the module doc above). Null when a post has
   *  no second meta segment. */
  @Column({ type: 'varchar', nullable: true })
  contextLabel: string | null;

  /** `PostKind` — the badge shown top-right of `TopicPostCard`. */
  @Column({ type: 'varchar' })
  kind: string;

  /** `PostCategory` — the bucket the `TopicFeed` filter chips group by. */
  @Column({ type: 'varchar' })
  category: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  /** Generalized "primary" engagement count — relate/upvotes/reads/going,
   *  depending on `kind`. `reactionLabel` names which one. */
  @Column({ type: 'int', default: 0 })
  reactionCount: number;

  @Column({ type: 'varchar' })
  reactionLabel: string;

  /** Generalized "secondary" engagement count — replies/bookmarks,
   *  depending on `kind`. Zero + a null label when a post kind has no
   *  second stat. */
  @Column({ type: 'int', default: 0 })
  replyCount: number;

  @Column({ type: 'varchar', nullable: true })
  replyLabel: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ type: 'varchar' })
  href: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

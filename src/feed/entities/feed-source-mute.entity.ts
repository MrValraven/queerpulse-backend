import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * The kinds of SOURCE a member can turn down in their own feed (SOC-18).
 *
 * Deliberately narrow. A mute here is a room or a conversation, never a
 * person: person-scoped silence already exists as `social/entities/mute.entity.ts`
 * and is enforced by `BlockFilterService`, and duplicating it here would give
 * the same relationship two contradictory stores.
 *
 * `community` covers everything that room produces: its posts, the forum
 * threads opened inside it, the gatherings it hosts, and the "X joined"
 * rows from its roster. `forum_thread` is the single conversation.
 */
export enum FeedSourceKind {
  Community = 'community',
  ForumThread = 'forum_thread',
}

/**
 * One row per (member, source) the member has asked their feed to show less
 * of (SOC-18 calls the table `feed_source_mute`; it is `feed_source_mutes`
 * here for the plural-table convention `mutes` / `topic_follows` /
 * `community_post_reactions` already set).
 *
 * MUTING IS NOT LEAVING. Nothing in this table touches `community_members`:
 * the member keeps their roster row, their access, their notifications and
 * their standing in the room. The only thing that changes is whether the
 * feed's read-time aggregation offers that source back to them
 * (`FeedService.fetchCandidates`). That is the whole point of the feature:
 * quieting a community used to cost a member their place in it.
 *
 * It is also always reversible. `GET /feed/mutes` lists every row with a
 * resolved name so the member can find what they silenced months ago, and
 * `DELETE /feed/mutes/:sourceKind/:sourceId` removes it.
 *
 * `sourceId` is a `uuid` for both kinds (`communities.id`, `forum_thread.id`)
 * with no FK: a deleted community or thread should leave a harmless orphan
 * row rather than cascade-mutate a member's own preferences, and the read
 * path only ever uses these ids as a NOT-IN filter.
 */
@Entity('feed_source_mutes')
@Unique('UQ_feed_source_mutes', ['userId', 'sourceKind', 'sourceId'])
export class FeedSourceMute {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_feed_source_mutes_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: FeedSourceKind,
    enumName: 'feed_source_mutes_source_kind_enum',
  })
  sourceKind!: FeedSourceKind;

  @Column({ type: 'uuid' })
  sourceId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

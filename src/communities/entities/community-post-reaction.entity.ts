import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum ReactionKey {
  Heart = 'heart',
  Celebrate = 'celebrate',
  Support = 'support',
  Fire = 'fire',
  // Reserved for the flat `POST /community-posts/:id/like` alias (see
  // `CommunityPostsController`/`CommunityPostsService.likeFlatPost`).
  // Deliberately excluded from `ReactionDto`'s `@IsIn` allowlist and from
  // `REACTION_KEY_ORDER` in `community-response.ts` so it never shows up in
  // the generic 4-key reaction summary — it's a dedicated "like" counter that
  // happens to reuse this table/store instead of a new one.
  Like = 'like',
}

@Entity('community_post_reactions')
@Unique('UQ_community_post_reactions', ['postId', 'userId', 'key'])
export class CommunityPostReaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_community_post_reactions_post_id')
  @Column({ type: 'uuid' })
  postId: string;

  @Index('IDX_community_post_reactions_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'enum',
    enum: ReactionKey,
    enumName: 'community_post_reactions_key_enum',
  })
  key: ReactionKey;
}

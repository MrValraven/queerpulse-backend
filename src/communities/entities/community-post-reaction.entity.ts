import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum ReactionKey {
  Heart = 'heart',
  Celebrate = 'celebrate',
  Support = 'support',
  Fire = 'fire',
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

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Covers `CommunityPostsService.topRepliesByPost`/`replyCountByPost`
// /`listReplies`'s `WHERE post_id = ... ORDER BY created_at ASC, id ASC`
// (including the `ROW_NUMBER() OVER (PARTITION BY post_id ...)` top-N-per-post
// preview window) in one index walk — see
// `1785700300000-AddCommunityPostRepliesOrderIndex.ts`.
@Index('IDX_community_post_replies_feed_order', ['postId', 'createdAt', 'id'])
@Entity('community_post_replies')
export class CommunityPostReply {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_community_post_replies_post_id')
  @Column({ type: 'uuid' })
  postId!: string;

  @Index('IDX_community_post_replies_author_id')
  @Column({ type: 'uuid' })
  authorId!: string;

  @Column({ type: 'text' })
  text!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  // Soft-tombstone marker (see `CommunityPostsService.deleteReply`). The `text`
  // above is preserved for restore + history.
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}

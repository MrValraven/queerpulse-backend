import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('community_post_replies')
export class CommunityPostReply {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_community_post_replies_post_id')
  @Column({ type: 'uuid' })
  postId: string;

  @Index('IDX_community_post_replies_author_id')
  @Column({ type: 'uuid' })
  authorId: string;

  @Column({ type: 'text' })
  text: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  editedAt: Date | null;

  // Soft-tombstone marker (see `CommunityPostsService.deleteReply`). The `text`
  // above is preserved for restore + history.
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One immutable revision row per community-reply edit, written *before* the
 * edit is applied (see `CommunityPostsService.updateReply`).
 */
@Entity('community_post_reply_edit')
export class CommunityPostReplyEdit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_community_post_reply_edit_reply_id')
  @Column({ type: 'uuid' })
  replyId: string;

  @Column({ type: 'text' })
  previousText: string;

  @Column({ type: 'uuid', nullable: true })
  editorId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One immutable revision row per forum-post edit, written *before* the edit is
 * applied (see `ForumPostsService.updatePostBody` /
 * `ForumThreadsService.updateThreadTitle`). `previousTitle` is populated only
 * for OP thread-title edits; body edits leave it null.
 */
@Entity('forum_post_edit')
export class ForumPostEdit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_forum_post_edit_post_id')
  @Column({ type: 'uuid' })
  postId: string;

  @Column({ type: 'text' })
  previousBody: string;

  @Column({ type: 'text', nullable: true })
  previousTitle: string | null;

  @Column({ type: 'uuid', nullable: true })
  editorId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

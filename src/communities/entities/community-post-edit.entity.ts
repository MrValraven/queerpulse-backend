import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One immutable revision row per community-post edit, written *before* the edit
 * is applied (see `CommunityPostsService.updatePost`). Community posts have no
 * title, so only `previousBody` is snapshotted.
 */
@Entity('community_post_edit')
export class CommunityPostEdit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_community_post_edit_post_id')
  @Column({ type: 'uuid' })
  postId: string;

  @Column({ type: 'text' })
  previousBody: string;

  @Column({ type: 'uuid', nullable: true })
  editorId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

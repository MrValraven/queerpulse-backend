import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum PostKind {
  Post = 'post',
  Announcement = 'announcement',
}

@Entity('community_posts')
export class CommunityPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_community_posts_community_id')
  @Column({ type: 'uuid' })
  communityId: string;

  @Index('IDX_community_posts_author_id')
  @Column({ type: 'uuid' })
  authorId: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', nullable: true })
  image: string | null;

  @Column({
    type: 'enum',
    enum: PostKind,
    enumName: 'community_posts_kind_enum',
    default: PostKind.Post,
  })
  kind: PostKind;

  @Column({ type: 'boolean', default: false })
  pinned: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

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

  // Nullable: a `null` community_id is a "flat"/global post created via
  // `POST /community-posts` without a `communitySlug` (see
  // `CommunityPostsService.createFlatPost`) — it isn't scoped to any
  // community's roster/membership and never appears in a single community's
  // `GET /:slug/posts` feed.
  @Index('IDX_community_posts_community_id')
  @Column({ type: 'uuid', nullable: true })
  communityId: string | null;

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

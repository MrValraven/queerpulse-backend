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
@Index('IDX_community_posts_created_at_id', ['createdAt', 'id'], {
  where: `"deleted_at" IS NULL`,
})
@Index('IDX_community_posts_feed_order', ['communityId', 'pinned', 'createdAt'])
export class CommunityPost {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Nullable: a `null` community_id is a "flat"/global post created via
  // `POST /community-posts` without a `communitySlug` (see
  // `CommunityPostsService.createFlatPost`) — it isn't scoped to any
  // community's roster/membership and never appears in a single community's
  // `GET /:slug/posts` feed.
  @Index('IDX_community_posts_community_id')
  @Column({ type: 'uuid', nullable: true })
  communityId!: string | null;

  // Nullable since `FixCommunityOwnerAuthorErasureCascades1789900000000`: the
  // FK was `ON DELETE CASCADE`, so an author's account erasure hard-deleted
  // their posts instead of tombstoning them — inconsistent with this
  // feature's own soft-delete design (member-initiated deletes preserve the
  // body as "[deleted]" with full edit history via `community_post_edit`).
  // Now `SET NULL`, mirroring `CommunityPostEdit.editorId`.
  @Index('IDX_community_posts_author_id')
  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'varchar', nullable: true })
  image!: string | null;

  @Column({
    type: 'enum',
    enum: PostKind,
    enumName: 'community_posts_kind_enum',
    default: PostKind.Post,
  })
  kind!: PostKind;

  @Column({ type: 'boolean', default: false })
  pinned!: boolean;

  // Millisecond precision (not Postgres's microsecond default): matches the
  // resolution of the JS `Date` cursor `cursorPaginate` builds from this
  // column, so the raw column can be ordered/filtered on directly instead of
  // through a non-indexable `date_trunc(...)` wrapper — see
  // `1785001400000-NarrowCursorCreatedAtPrecision.ts` and
  // `common/cursor-pagination.ts`.
  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  // Soft-tombstone marker. When set, the post renders as "[deleted]" but the
  // `body` above is preserved so the author (or the community's owner/mod) can
  // restore it and its edit history stays readable
  // (see `CommunityPostsService.deletePost`).
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  // WHO set the tombstone above. Without this, `restore` could not tell an
  // author's own delete apart from a moderator takedown, so the author simply
  // undid a mod's removal (BE-COM-01). Only the actor who set the tombstone —
  // or the community's owner/mod — may clear it; see
  // `CommunityPostsService.assertCanRestore`.
  //
  // NULL means either "not tombstoned" or a LEGACY tombstone written before
  // `AddContentTombstoneActor1793520000000` added this column; the restore
  // check treats the legacy case as the old author-or-staff rule rather than
  // inventing an actor. `ON DELETE SET NULL` for account erasure, like every
  // other actor reference on this table.
  @Column({ type: 'uuid', nullable: true })
  deletedById!: string | null;
}

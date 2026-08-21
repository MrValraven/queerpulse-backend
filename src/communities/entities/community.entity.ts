import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum CommunityType {
  Social = 'social',
  Arts = 'arts',
  Activism = 'activism',
  Support = 'support',
  Sports = 'sports',
  Professional = 'professional',
}

export enum AccessTier {
  Public = 'public',
  Request = 'request',
  Invite = 'invite',
  Private = 'private',
}

@Entity('communities')
export class Community {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_communities_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'text' })
  purpose!: string;

  @Column({
    type: 'enum',
    enum: CommunityType,
    enumName: 'communities_type_enum',
  })
  type!: CommunityType;

  @Column({ type: 'text' })
  whoFor!: string;

  @Column({ type: 'varchar' })
  tagline!: string;

  @Column({
    type: 'enum',
    enum: AccessTier,
    enumName: 'communities_access_tier_enum',
  })
  accessTier!: AccessTier;

  @Column({ type: 'boolean', default: true })
  rosterVisible!: boolean;

  // Safety policies platform staff toggle from the admin community detail's
  // Settings tab. Persistence is wired end to end (they save and survive a
  // reload); enforcement — gating a join on a second vouch, auto-freezing when
  // open reports pile up — is a deliberate follow-up, so these are stored
  // intent only for now. Both default off; paired migration
  // `1788900000000-AddCommunitySafetyPolicies`.
  @Column({ type: 'boolean', default: false })
  requiresSecondVouch!: boolean;

  @Column({ type: 'boolean', default: false })
  autoFreezeOnReports!: boolean;

  // The one community the Communities Discover page's hero card shows,
  // platform-wide. An admin toggle (`AdminCommunitiesService.updateSettings`)
  // enforces "only one row is ever true" in application code — setting this
  // clears every other `true` row in the same transaction. Paired migration
  // `1793200000000-AddCommunityFeaturedFlag`.
  @Column({ type: 'boolean', default: false })
  isFeatured!: boolean;

  @Column({ type: 'text', array: true, default: '{}' })
  features!: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  rules!: string[];

  // Curated browse/filter tags the owner picks from the fixed
  // `COMMUNITY_TAGS` vocabulary (`src/communities/community-tags.ts`) —
  // unlike `forum_thread.tags`, these are NOT freeform. Migration-owned GIN
  // index (`IDX_communities_tags`, see `AddCommunityTags`) backs
  // `c.tags && :tags` overlap filtering — TypeORM's `@Index` can't express
  // an array/GIN operator class, so it lives in the migration, not a
  // decorator here (same precedent as `ForumThread.tags`).
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  tags!: string[];

  // Optional cover image for the community, surfaced on the public homepage
  // featured-community card and the community's own detail page. Stores a raw
  // storage key (uploaded via the `community-cover` upload kind) or an absolute
  // `https://` URL, resolved to a fetchable `/files/*` URL through `toImageUrl`
  // at the response boundary — never the resolved URL itself. Nullable (no
  // cover by default); the paired UNAPPLIED migration is
  // `1787700500000-AddCommunityCoverImageUrl`.
  @Column({ type: 'varchar', nullable: true })
  coverImageUrl!: string | null;

  // Nullable since `FixCommunityOwnerAuthorErasureCascades1789900000000`: the FK
  // was `ON DELETE CASCADE` (the erased owner's account taking the whole
  // community with it — every post, reply, reaction, member, and join
  // request), which is inconsistent with every other actor-reference in this
  // feature (`ON DELETE SET NULL`, "for account erasure"). Now `SET NULL`:
  // an erased owner leaves the community intact with `ownerId` NULL.
  // `CommunityOwnerOrphanService.handleOwnerErasure` reacts by promoting the
  // longest-tenured `mod` to owner, or — if the roster has no mod — leaving
  // this NULL and stamping `needsOwnerReviewAt` for an admin surface to
  // triage. A NULL here means "ownerless", not "no such community"; callers
  // reading `Community.ownerId` for authority checks must treat NULL as "no
  // one currently holds owner-only powers" rather than assume non-null.
  @Index('IDX_communities_owner_id')
  @Column({ type: 'uuid', nullable: true })
  ownerId!: string | null;

  @Index('UQ_communities_ref', { unique: true })
  @Column({ type: 'varchar' })
  ref!: string;

  // Indexed so `AdminCommunitiesService.listCommunities`'s `ORDER BY
  // created_at ASC ... LIMIT` (see `1785700200000-AddCommunitiesCreatedAtIndex`)
  // can be served by an `Index Scan ... Limit` instead of a full-table
  // `Seq Scan` + `Sort`.
  @Index('IDX_communities_created_at')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  // Set when an owner archives the community from the mod panel's danger zone.
  // A non-null value takes the community down for everyone but its own
  // owner/mods (mirrors the moderation-takedown posture in
  // `CommunitiesService.getBySlug`) and hides it from every listing. Nullable
  // (never archived by default); the paired UNAPPLIED migration is
  // `1785800600000-AddCommunityArchivedAt`.
  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  // Set when the community is auto-frozen because open reports piled up or an
  // emergency report (doxxing/outing) landed, while `autoFreezeOnReports` is on.
  // Unlike `archivedAt` (which 404s the community), a frozen community stays
  // fully visible but blocks new joins and new posts/replies/reactions from
  // plain members until an owner/mod lifts it. Nullable (not frozen by default);
  // paired migration `1789000000000-AddCommunityFrozenAt`.
  @Column({ type: 'timestamptz', nullable: true })
  frozenAt!: Date | null;

  // Set by `CommunityOwnerOrphanService.handleOwnerErasure` when the owner's
  // account is erased and the roster has no `mod` to promote, leaving
  // `ownerId` NULL. Nullable (unset while the community has an owner); lets an
  // admin surface later query `WHERE needs_owner_review_at IS NOT NULL` for
  // ownerless communities that need a manual owner assignment. Paired
  // migration `FixCommunityOwnerAuthorErasureCascades1789900000000`.
  @Column({ type: 'timestamptz', nullable: true })
  needsOwnerReviewAt!: Date | null;
}

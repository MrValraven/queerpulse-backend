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

// Why a community is currently frozen. Set alongside `frozenAt` by every
// freeze path (manual owner/mod freeze, or `CommunityAutoFreezeService`'s two
// automatic triggers) and cleared with it. Drives who may LIFT the freeze —
// see `CommunitiesService.unfreeze`: an owner/mod may lift their own `manual`
// freeze at will, but an automatic one only once the community's open reports
// are actually handled. Values match the `reason` string the governance log
// and the staff notification payload already carry.
export enum CommunityFrozenReason {
  Manual = 'manual',
  EmergencyReport = 'emergency_report',
  ReportPileup = 'report_pileup',
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
  // Settings tab. Both are ENFORCED, and both default off; paired migration
  // `1788900000000-AddCommunitySafetyPolicies`.
  //
  // `requiresSecondVouch` gates admission: while it is on, an applicant is
  // only admitted once a CURRENT member of this community holds an active
  // platform vouch for them (`CommunitiesService.hasMemberVouch`). It is
  // enforced twice, at both doors: instant join on a `public` community is
  // withheld and routed to a reviewable request instead, and `approve` on a
  // join request is refused (a mod is a member, so they can vouch first and
  // then approve). Declining is always allowed.
  @Column({ type: 'boolean', default: false })
  requiresSecondVouch!: boolean;

  // `autoFreezeOnReports` arms `CommunityAutoFreezeService`, which watches
  // reports against the community and freezes it automatically on either
  // trigger: a single emergency report (doxxing/outing), or open reports
  // piling past its threshold. The freeze it applies stamps `frozenAt` plus
  // the matching `frozenReason` (`emergency_report` / `report_pileup`), and
  // only an owner/mod who has actually handled the open reports can lift it
  // (see `CommunitiesService.unfreeze`).
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

  // Why the freeze above was applied (see `CommunityFrozenReason`). NULL means
  // "not frozen", and also covers any row frozen before
  // `AddCommunityFrozenReason1793520100000` added this column — `unfreeze`
  // treats that legacy case as an AUTOMATIC freeze (the conservative
  // direction: a manual freeze is the one an owner may always lift).
  @Column({
    type: 'enum',
    enum: CommunityFrozenReason,
    enumName: 'communities_frozen_reason_enum',
    nullable: true,
  })
  frozenReason!: CommunityFrozenReason | null;

  // Set by `CommunityOwnerOrphanService.handleOwnerErasure` when the owner's
  // account is erased and the roster has no `mod` to promote, leaving
  // `ownerId` NULL. Nullable (unset while the community has an owner); lets an
  // admin surface later query `WHERE needs_owner_review_at IS NOT NULL` for
  // ownerless communities that need a manual owner assignment. Paired
  // migration `FixCommunityOwnerAuthorErasureCascades1789900000000`.
  @Column({ type: 'timestamptz', nullable: true })
  needsOwnerReviewAt!: Date | null;

  // Bumped by the owner-facing community update path whenever `rules` change
  // in a way the owner considers material. Members record the version they
  // agreed to in `community_members.rules_version_accepted`, so a bump is what
  // re-prompts the roster: agreement to v1 says nothing about v2. Starts at 1
  // and is NOT NULL, so every community that predates this reads as "rules v1"
  // and nobody is re-prompted merely by the column arriving. Paired migration
  // `1793810000000-AddCommunityRulesAcceptance`.
  @Column({ type: 'integer', default: 1 })
  rulesVersion!: number;

  // Owner-authored greeting, shown ONCE to a member on their first visit after
  // joining and then never again (the per-member stamp lives on
  // `community_members.welcome_seen_at`). This is the "you're in, here is what
  // to do first" note that otherwise gets pasted into a pinned post nobody
  // reads. Nullable: most communities have none, and NULL means the welcome
  // step is skipped entirely rather than shown empty. Paired migration
  // `1793850000000-AddCommunityWelcomeMessage`.
  @Column({ type: 'text', nullable: true })
  welcomeMessage!: string | null;

  // The community's own avatar (the small square identity mark), distinct from
  // `coverImageUrl`'s wide banner. Same storage convention as that column:
  // this stores a RAW STORAGE KEY (uploaded via the community image upload
  // kind) or an absolute `https://` URL, and is resolved to a fetchable
  // `/files/*` URL through `toImageUrl` at the response boundary. Never store
  // the resolved URL here: resolved URLs expire and are environment-specific,
  // so a persisted one goes stale and cannot be re-signed. Nullable (falls
  // back to the generated initial/crest mark). Paired migration
  // `1793860000000-AddCommunityAvatarImageUrl`.
  @Column({ type: 'varchar', nullable: true })
  avatarImageUrl!: string | null;

  // Where the community actually meets. `city` is the free-ish city label the
  // owner picks, `area` the neighbourhood or region inside it, and `isOnline`
  // marks a community that gathers online (the two are not exclusive: a local
  // group that also meets on a call is both). Indexed on `city` because
  // discover filters by it. Paired migration
  // `1793870000000-AddCommunityPlaceAndLanguages`.
  @Index('IDX_communities_city')
  @Column({ type: 'varchar', nullable: true })
  city!: string | null;

  @Column({ type: 'varchar', nullable: true })
  area!: string | null;

  @Column({ type: 'boolean', default: false })
  isOnline!: boolean;

  // Languages the community actually runs in, so a member can find a room they
  // can speak in. Migration-owned GIN index (`IDX_communities_languages`, see
  // `AddCommunityPlaceAndLanguages`) backs the `c.languages && :languages`
  // overlap filter. TypeORM's `@Index` cannot express an array/GIN operator
  // class, so that index lives in the migration and not in a decorator here,
  // exactly the precedent set by `tags` above and `ForumThread.tags`.
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  languages!: string[];

  // DENORMALISED activity counter: how many distinct members posted or replied
  // in this community over the trailing week, refreshed on a schedule (with
  // `activityCountedAt` recording the last refresh) rather than computed per
  // request. It exists so discover can SORT and FILTER by liveliness in SQL.
  // Today the frontend drains every page of the community list and counts
  // client-side, which cannot be paginated and gets worse with every community
  // added. NOT NULL default 0, so an un-refreshed row sorts as quiet instead
  // of vanishing from a `WHERE` clause. Treat it as approximate: it is a
  // cached count, and `activityCountedAt` is how stale it is allowed to be.
  // Indexed for the discover sort. Paired migration
  // `1793880000000-AddCommunityActivityCounter`.
  @Index('IDX_communities_active_this_week')
  @Column({ type: 'integer', default: 0 })
  activeThisWeek!: number;

  // When `activeThisWeek` was last recomputed. NULL means never counted (every
  // row before the refresh job first runs), which readers should show as
  // "unknown" rather than "zero activity". Paired migration
  // `1793880000000-AddCommunityActivityCounter`.
  @Column({ type: 'timestamptz', nullable: true })
  activityCountedAt!: Date | null;

  // Owner opt-in to a signed-out TEASER of this community, default OFF.
  //
  // The policy, precisely: turning this on is the owner's decision alone, it
  // defaults to false so shipping the feature exposes nothing that was private
  // yesterday, and it is only meaningful for the `public` and `request` access
  // tiers. An `invite` or `private` community setting this true still shows
  // nothing to a signed-out visitor, because being findable is incompatible
  // with those tiers by definition.
  //
  // What a listed community exposes to a signed-out visitor is a LIMITED set
  // and nothing beyond it: name, tagline, purpose, tags, member COUNT, and the
  // next public gathering. It never exposes the roster (no names, no avatars,
  // no count of who is who) and never exposes a single post, reply or reaction.
  // The signed-out response builder is the one place that boundary is drawn,
  // so anything added to the community DTO later is opt-in there too.
  //
  // Paired migration `1793890000000-AddCommunityPublicListing`.
  @Column({ type: 'boolean', default: false })
  isPubliclyListed!: boolean;

  // A short PUBLIC note a moderator may attach to a freeze, explaining the
  // pause in the community's own words ("paused while we rewrite the rules",
  // "on hold until the March meeting"). Shown alongside the frozen state to
  // everyone who can see the community, so it holds no moderation detail: the
  // reason a freeze happened stays in `frozenReason` and the governance log.
  // Nullable, and cleared with `frozenAt` when the freeze is lifted. Paired
  // migration `1793900000000-AddCommunityFrozenNote`.
  @Column({ type: 'varchar', nullable: true })
  frozenNote!: string | null;

  // Who applied the freeze. Nullable and `ON DELETE SET NULL` for account
  // erasure, the actor-FK convention this module follows: a moderator leaving
  // the platform must not lift a freeze they applied. Also NULL for an
  // automatic freeze, which no person applied (`frozenReason` distinguishes
  // the two). Paired migration `1793900000000-AddCommunityFrozenNote`.
  @Column({ type: 'uuid', nullable: true })
  frozenByUserId!: string | null;
}

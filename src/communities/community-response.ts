import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import {
  AccessTier,
  Community,
  CommunityFrozenReason,
  CommunityType,
} from './entities/community.entity';
import {
  CommunityJoinRequest,
  CommunityJoinRequestDeclineKind,
  CommunityJoinRequestInvolvement,
  JoinRequestStatus,
} from './entities/community-join-request.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPost, PostKind } from './entities/community-post.entity';
import { ReactionKey } from './entities/community-post-reaction.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';

/** The viewer, as the post/reply mappers need them: their user id plus their
 *  roster role in *this* community (null when they aren't a member — e.g. a
 *  non-member browsing a public-tier feed). Owner/mod unlocks delete/restore/
 *  history; edit stays author-only regardless of role. */
export interface CommunityPostViewer {
  userId: string;
  role: RosterRole | null;
}

// The post/reply "can I moderate this" test. A co-owner holds owner-level
// powers inside the community (see the permission model at
// `CommunitiesService.isOwnerLevelRole`), so it sits on this side of the line
// with the owner and mods.
function isOwnerOrMod(role: RosterRole | null): boolean {
  return (
    role === RosterRole.Owner ||
    role === RosterRole.CoOwner ||
    role === RosterRole.Mod
  );
}

// Author identity hidden on a tombstoned post/reply. The frontend branches on
// the `deleted` flag and renders its own "[deleted]" label, so these values are
// only a safe fallback, never shown verbatim.
const DELETED_MEMBER: MemberRef = {
  slug: '',
  firstName: '',
  lastName: '',
  pronouns: null,
  avatarUrl: null,
};

/**
 * The three derived numbers every card/detail view needs
 * (`EventsService.summarize`'s grouped-count pattern, batched per page by
 * `CommunitiesService.statsForMany` or computed singly by `statsFor`).
 */
export interface CommunityStats {
  memberCount: number;
  // Distinct post/reply authors over the last 7 days, computed per page by
  // `statsForMany`. Same definition as the denormalised
  // `communities.active_this_week` column that `?sort=active` orders by (see
  // `CommunityActivityCounterService`); this one is computed at read time, the
  // column is the hourly-refreshed cache that makes the sort possible before
  // pagination. Cards carry the number so a "busy this week" treatment needs
  // no second call.
  activeThisWeek: number;
  postsThisWeek: number;
}

export interface CommunityCardDTO {
  slug: string;
  name: string;
  type: CommunityType;
  tagline: string;
  accessTier: AccessTier;
  ref: string;
  memberCount: number;
  activeThisWeek: number;
  postsThisWeek: number;
  myRole: RosterRole | null;
  // Resolved (`toImageUrl`) cover-image URL, or null when the community has no
  // cover. Discover-grid/featured cards render this; the owner's edit form
  // seeds its `ImageUploadField` from the same field off the detail DTO.
  coverImageUrl: string | null;
  // Curated ids from COMMUNITY_TAGS; empty when the owner set none. Surfaced
  // on the card (not just the detail) so `GET /communities?tags=` results can
  // render matched tags without a second fetch.
  tags: string[];
  // Resolved (`toImageUrl`) avatar URL, or null when the community has none
  // and the client should fall back to its generated initial mark.
  avatarImageUrl: string | null;
  // Where the community meets, and which languages it runs in. On the CARD
  // rather than only the detail for the same reason `tags` is: these are the
  // facets `GET /communities?city=&language=&online=` filters on, so a result
  // row has to be able to show why it matched without a second fetch.
  city: string | null;
  area: string | null;
  isOnline: boolean;
  languages: string[];
}

export interface CommunityDetailDTO extends CommunityCardDTO {
  purpose: string;
  whoFor: string;
  rosterVisible: boolean;
  features: string[];
  rules: string[];
  /** Crop rect for `coverImageUrl`, when the owner reframed it. */
  coverCrop?: CropRect;
  owner: MemberRef | null;
  createdAt: string;
  // True once an owner has archived the community. Only ever reaches an
  // owner/mod — outsiders get a 404 for an archived community, never this
  // detail — so the mod panel can show the archived state instead of pretending
  // the community is still live.
  archived: boolean;
  // True while the community is auto-frozen pending report review. Unlike
  // `archived`, a frozen community stays visible to everyone, so this reaches
  // all viewers — the hub shows a "frozen, under review" banner, and its
  // owner/mods get the unfreeze control.
  frozen: boolean;
  // The freeze, in enough detail for a member to be told the truth about it.
  // `frozen` alone forced the client to word all three reasons as "moderators
  // are reviewing recent reports", which is alarming and simply untrue of a
  // manual pause where no report exists. `frozenReason` distinguishes a
  // deliberate pause from the two automatic triggers, `frozenNote` is the
  // moderator's own short public line about it (null when none was written),
  // and `frozenAt` is when it started. All three read as null while the
  // community is not frozen, whatever the columns still hold. `frozenByUserId` is deliberately NOT exposed: who froze a
  // community is moderation detail and lives in the governance log.
  frozenAt: string | null;
  frozenReason: CommunityFrozenReason | null;
  frozenNote: string | null;
  myJoinRequestStatus: JoinRequestStatus | null;
  // A moderator takedown. Only ever surfaced to an owner/mod — outsiders get a
  // 404 for a moderated community, never this detail — so they know why the
  // community is no longer publicly reachable.
  moderationRemoved: boolean;
  moderationHidden: boolean;
  // The community's current house-rules version, and the version THIS viewer
  // last agreed to. `rulesAcceptedVersion` is null when the viewer is not a
  // member, and also for a member who joined before rules acceptance existed.
  // The client re-prompts whenever `rulesAcceptedVersion` is null or trails
  // `rulesVersion` and the community actually has rules, which is how an
  // existing roster is asked to re-agree after an owner edits them.
  rulesVersion: number;
  rulesAcceptedVersion: number | null;
  // The owner's once-only greeting for a new joiner. STAFF ONLY here: this is
  // the settings-form value, and the member-facing read (which also carries
  // "has this member seen it yet") is `GET /communities/:slug/preferences`.
  // Null for anyone who is not owner/co-owner/mod, and for a community with
  // no greeting set.
  welcomeMessage: string | null;
  // Whether a signed-out visitor can see this community's teaser. Surfaced to
  // every viewer, not just staff: a member is entitled to know their
  // community is findable by people who are not on this platform. Only ever
  // true while `accessTier` is `public` or `request`.
  isPubliclyListed: boolean;
}

export function toCommunityCard(
  c: Community,
  stats: CommunityStats,
  myRole: RosterRole | null,
): CommunityCardDTO {
  return {
    slug: c.slug,
    name: c.name,
    type: c.type,
    tagline: c.tagline,
    accessTier: c.accessTier,
    ref: c.ref,
    memberCount: stats.memberCount,
    activeThisWeek: stats.activeThisWeek,
    postsThisWeek: stats.postsThisWeek,
    myRole,
    coverImageUrl: toImageUrl(c.coverImageUrl),
    tags: c.tags,
    avatarImageUrl: toImageUrl(c.avatarImageUrl),
    city: c.city,
    area: c.area,
    isOnline: c.isOnline,
    languages: c.languages,
  };
}

export function toCommunityDetail(
  c: Community,
  stats: CommunityStats,
  myRole: RosterRole | null,
  owner: MemberRef | null,
  myJoinRequestStatus: JoinRequestStatus | null,
  moderation?: CommunityContentModeration,
  // Pre-loaded crop lookup for `coverImageUrl` — the caller batches ONE
  // `MediaCropService.getMany` and passes the resulting Map straight through;
  // this mapper stays synchronous.
  crops: Map<string, CropRect> = new Map(),
  // The viewer's own `community_members.rules_version_accepted`. Defaults to
  // null, which is the honest answer for a non-member and for a member who
  // joined before acceptance was recorded.
  rulesAcceptedVersion: number | null = null,
): CommunityDetailDTO {
  return {
    ...toCommunityCard(c, stats, myRole),
    purpose: c.purpose,
    whoFor: c.whoFor,
    rosterVisible: c.rosterVisible,
    features: c.features,
    rules: c.rules,
    coverCrop: cropFor(c.coverImageUrl, crops),
    owner,
    createdAt: c.createdAt.toISOString(),
    archived: c.archivedAt != null,
    frozen: c.frozenAt != null,
    // Read as a set, gated on the freeze actually being live. A path that
    // clears `frozenAt` without clearing the note (platform staff lifting a
    // freeze through `AdminCommunitiesService`, for one) must not leave
    // members reading an explanation for a pause that ended.
    frozenAt: c.frozenAt ? c.frozenAt.toISOString() : null,
    frozenReason: c.frozenAt ? c.frozenReason : null,
    frozenNote: c.frozenAt ? c.frozenNote : null,
    myJoinRequestStatus,
    moderationRemoved: moderation?.removed ?? false,
    moderationHidden: moderation?.hidden ?? false,
    rulesVersion: c.rulesVersion,
    rulesAcceptedVersion,
    welcomeMessage: isOwnerOrMod(myRole) ? c.welcomeMessage : null,
    isPubliclyListed: c.isPubliclyListed,
  };
}

export interface RosterEntryDTO {
  member: MemberRef;
  role: RosterRole;
  joinedAt: string;
}

/**
 * One row of `GET /me/communities` — the caller's own membership in a
 * community, flattened to just what a membership *map* needs (slug -> role).
 * Deliberately not a `CommunityCardDTO`: this endpoint is a membership index,
 * not a listing, so it carries no stats and no `myRole` (the `role` here *is*
 * the caller's role).
 */
export interface MyCommunityDTO {
  slug: string;
  name: string;
  role: RosterRole;
  joinedAt: string;
  /**
   * Whether this community runs a LIVE membership-card programme, so the
   * client can answer a cardless member's "why do I have no card, and can I
   * get one?" without a per-community request each.
   *
   * True only while the programme is enabled: a paused one issues nothing
   * today, so pointing a member at it would be a dead end. It says nothing
   * about whether this member holds a card (their wallet is
   * `GET /me/cards`), only that this community is somewhere a card can come
   * from.
   */
  hasCardProgram: boolean;
}

/** Result of a role change on `PATCH /communities/:slug/members/:memberSlug`.
 * `slug` is the community, `memberSlug` the member whose role changed. */
export interface MemberRoleDTO {
  slug: string;
  memberSlug: string;
  role: RosterRole;
}

/**
 * What a reviewer needs to know about the person behind a join request,
 * beyond their name. Computed in BATCH for a whole queue by
 * `CommunitiesService.applicantContexts` (never per row), and left undefined
 * on the surfaces that have no reviewer: the applicant's own
 * `POST /communities/:slug/join` echo carries nulls here, so nobody learns
 * their own reviewer-side signals.
 */
export interface JoinRequestApplicantContext {
  // When the applicant's ACCOUNT was created (`users.created_at`), which is
  // the "is this a week-old account" signal a reviewer actually wants. Not
  // when the request was filed, which is `createdAt`.
  accountCreatedAt: Date;
  // Connections the applicant and the REVIEWING moderator have in common.
  sharedConnectionCount: number;
  // Other communities the applicant is in that at least one member of THIS
  // community's roster is also in.
  sharedCommunityCount: number;
}

export interface CommunityJoinRequestDTO {
  id: string;
  // Carries the applicant's profile `slug` and `pronouns` already, so the
  // reviewer surface reads both from here rather than duplicating them.
  member: MemberRef;
  note: string | null;
  // The applicant's self-reported answer to "how do you want to take part".
  // Null when they skipped the question or the request predates the field.
  involvement: CommunityJoinRequestInvolvement | null;
  status: JoinRequestStatus;
  // Set on a decline. `declineKind` lets the client word "not right now" and
  // "not a fit" differently; `declineReason` is the reviewer's own words,
  // which this column exists to carry TO THE APPLICANT (moderator-only notes
  // live in `internalNote`, which no response ever includes). `reapplyAfter`
  // is the earliest the applicant may file again, null when there is no wait.
  declineKind: CommunityJoinRequestDeclineKind | null;
  declineReason: string | null;
  reapplyAfter: string | null;
  // Reviewer-side context. Null on any surface that computed none (see
  // `JoinRequestApplicantContext`).
  accountCreatedAt: string | null;
  sharedConnectionCount: number | null;
  sharedCommunityCount: number | null;
  createdAt: string;
}

export interface JoinResultDTO {
  outcome: 'joined' | 'requested';
  role: RosterRole.Member | null; // set when joined
  request: CommunityJoinRequestDTO | null; // set when requested
}

/** `memberRef` is required (not `| null`) — every roster row/join-request is
 * tied to a real profile by the time it's mapped; callers resolve it via
 * `MemberLookup` and filter out any (shouldn't-happen) unresolved rows before
 * calling these, mirroring `EventsService.attendees`'s
 * `.filter((r) => profiles.has(r.userId))` idiom. */
export function toRosterEntry(
  member: CommunityMember,
  memberRef: MemberRef,
): RosterEntryDTO {
  return {
    member: memberRef,
    role: member.role,
    joinedAt: member.joinedAt.toISOString(),
  };
}

export function toJoinRequestDTO(
  request: CommunityJoinRequest,
  memberRef: MemberRef,
  // Omitted on the applicant-facing surfaces, which have no reviewer to
  // compute it for.
  context?: JoinRequestApplicantContext,
): CommunityJoinRequestDTO {
  return {
    id: request.id,
    member: memberRef,
    note: request.note,
    involvement: request.involvement,
    status: request.status,
    declineKind: request.declineKind,
    declineReason: request.declineReason,
    reapplyAfter: request.reapplyAfter
      ? request.reapplyAfter.toISOString()
      : null,
    accountCreatedAt: context ? context.accountCreatedAt.toISOString() : null,
    sharedConnectionCount: context ? context.sharedConnectionCount : null,
    sharedCommunityCount: context ? context.sharedCommunityCount : null,
    createdAt: request.createdAt.toISOString(),
    // `internalNote` is deliberately absent: it is moderator-only working
    // notes and must never reach a response body.
  };
}

export interface CommunityReactionSummary {
  key: ReactionKey;
  count: number;
  mine: boolean;
}

// A moderator takedown on a post/reply, resolved from the shared
// `content_moderation` table. Optional on the mappers: create/react echoes
// that don't consult it leave it undefined = untouched.
export interface CommunityContentModeration {
  hidden: boolean;
  removed: boolean;
}

export interface CommunityReplyDTO {
  id: string;
  author: MemberRef | null;
  text: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canViewHistory: boolean;
  moderationRemoved: boolean;
  moderationHidden: boolean;
}

export interface CommunityPostDTO {
  id: string;
  author: MemberRef | null;
  body: string;
  image: string | null;
  kind: PostKind;
  pinned: boolean;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canViewHistory: boolean;
  reactions: CommunityReactionSummary[]; // always all 4 keys, count + mine
  replies: CommunityReplyDTO[];
  replyCount: number;
  moderationRemoved: boolean;
  moderationHidden: boolean;
}

/** Fixed key order every reaction summary is rendered in (matches the spec's
 * `ReactionKey` union order), so the 4-entry array is stable regardless of
 * which keys actually have rows. */
const REACTION_KEY_ORDER: ReactionKey[] = [
  ReactionKey.Heart,
  ReactionKey.Celebrate,
  ReactionKey.Support,
  ReactionKey.Fire,
];

/**
 * Aggregate reaction data for a single post: a count per key plus the
 * viewer's own reacted keys — resolved via a `GROUP BY` and a viewer-scoped
 * lookup (`CommunityPostsService.reactionAggregatesByPost`), never by
 * fetching every reaction row. A post with thousands of reactions used to
 * mean thousands of rows fetched (and shipped, pre-truncation) just to
 * compute 4 numbers; this is the bounded replacement.
 */
export interface ReactionAggregate {
  counts: Map<ReactionKey, number>;
  mine: Set<ReactionKey>;
}

/**
 * Builds the 4-entry (one per `ReactionKey`, always present even at count 0)
 * summary for a single post from its pre-aggregated reaction data.
 */
export function toReactionSummaries(
  reactions: ReactionAggregate,
): CommunityReactionSummary[] {
  return REACTION_KEY_ORDER.map((key) => ({
    key,
    count: reactions.counts.get(key) ?? 0,
    mine: reactions.mine.has(key),
  }));
}

export function toCommunityReply(
  reply: CommunityPostReply,
  author: MemberRef | null,
  viewerId: string,
  viewerRole: RosterRole | null,
  moderation?: CommunityContentModeration,
): CommunityReplyDTO {
  const authorTombstoned = reply.deletedAt != null;
  const moderationRemoved = moderation?.removed ?? false;
  const moderationHidden = moderation?.hidden ?? false;
  const blanked = authorTombstoned || moderationRemoved || moderationHidden;
  const isAuthor = reply.authorId === viewerId;
  const isMember = viewerRole != null;
  const canManage = (isAuthor || isOwnerOrMod(viewerRole)) && isMember;
  return {
    id: reply.id,
    author: blanked ? DELETED_MEMBER : author,
    text: blanked ? '' : reply.text,
    createdAt: reply.createdAt.toISOString(),
    editedAt: reply.editedAt ? reply.editedAt.toISOString() : null,
    deleted: authorTombstoned || moderationRemoved,
    canEdit: isAuthor && isMember && !blanked, // edit is author-only (owner/mod excluded)
    canDelete: canManage && !blanked,
    // Only an author's own tombstone is restorable here; a moderator takedown
    // is lifted through the moderation/appeal path. A tombstone set by the
    // community's owner/mod is likewise only clearable BY an owner/mod — the
    // flag mirrors `CommunityPostsService.assertCanRestore` so the button is
    // absent rather than 403-ing on click (a null `deletedById` is a legacy
    // tombstone, which that check lets the author restore).
    canRestore:
      canManage &&
      authorTombstoned &&
      !moderationRemoved &&
      (isOwnerOrMod(viewerRole) ||
        reply.deletedById == null ||
        reply.deletedById === viewerId),
    canViewHistory: canManage && reply.editedAt != null,
    moderationRemoved,
    moderationHidden,
  };
}

/**
 * `reactions` is the pre-aggregated reaction data (see `toReactionSummaries`);
 * `replies` is already `CommunityReplyDTO[]` (mapped via `toCommunityReply` by
 * the caller, which is the one that knows how to resolve each reply author's
 * `MemberRef`) — bounded to a preview page, NOT every reply. `replyCount` is
 * the true total (`CommunityPostsService.replyCountByPost`), passed
 * separately so it stays correct even once `replies` is truncated — the
 * client compares `replies.length < replyCount` to know whether to fetch more
 * via `GET .../posts/:id/replies`.
 */
export function toCommunityPost(
  post: CommunityPost,
  author: MemberRef | null,
  reactions: ReactionAggregate,
  replies: CommunityReplyDTO[],
  replyCount: number,
  viewerId: string,
  viewerRole: RosterRole | null,
  moderation?: CommunityContentModeration,
): CommunityPostDTO {
  const authorTombstoned = post.deletedAt != null;
  const moderationRemoved = moderation?.removed ?? false;
  const moderationHidden = moderation?.hidden ?? false;
  const blanked = authorTombstoned || moderationRemoved || moderationHidden;
  const isAuthor = post.authorId === viewerId;
  const isMember = viewerRole != null;
  const canManage = (isAuthor || isOwnerOrMod(viewerRole)) && isMember;
  return {
    id: post.id,
    author: blanked ? DELETED_MEMBER : author,
    body: blanked ? '' : post.body,
    image: blanked ? null : toImageUrl(post.image),
    kind: post.kind,
    pinned: post.pinned,
    createdAt: post.createdAt.toISOString(),
    editedAt: post.editedAt ? post.editedAt.toISOString() : null,
    deleted: authorTombstoned || moderationRemoved,
    canEdit: isAuthor && isMember && !blanked, // edit is author-only (owner/mod excluded)
    canDelete: canManage && !blanked,
    // See `toCommunityReply`'s note: mirrors
    // `CommunityPostsService.assertCanRestore`.
    canRestore:
      canManage &&
      authorTombstoned &&
      !moderationRemoved &&
      (isOwnerOrMod(viewerRole) ||
        post.deletedById == null ||
        post.deletedById === viewerId),
    canViewHistory: canManage && post.editedAt != null,
    reactions: toReactionSummaries(reactions),
    replies,
    replyCount,
    moderationRemoved,
    moderationHidden,
  };
}

export interface CommunityPostHistoryEntry {
  id: string;
  author: MemberRef | null;
  previousBody: string;
  createdAt: string;
}

export interface CommunityPostHistoryResponse {
  revisions: CommunityPostHistoryEntry[];
}

export function toCommunityPostHistoryEntry(
  edit: {
    id: string;
    previousBody: string;
    editorId: string | null;
    createdAt: Date;
  },
  author: MemberRef | null,
): CommunityPostHistoryEntry {
  return {
    id: edit.id,
    author,
    previousBody: edit.previousBody,
    createdAt: edit.createdAt.toISOString(),
  };
}

export interface CommunityReplyHistoryEntry {
  id: string;
  author: MemberRef | null;
  previousText: string;
  createdAt: string;
}

export interface CommunityReplyHistoryResponse {
  revisions: CommunityReplyHistoryEntry[];
}

export function toCommunityReplyHistoryEntry(
  edit: {
    id: string;
    previousText: string;
    editorId: string | null;
    createdAt: Date;
  },
  author: MemberRef | null,
): CommunityReplyHistoryEntry {
  return {
    id: edit.id,
    author,
    previousText: edit.previousText,
    createdAt: edit.createdAt.toISOString(),
  };
}

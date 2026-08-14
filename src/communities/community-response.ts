import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import {
  AccessTier,
  Community,
  CommunityType,
} from './entities/community.entity';
import {
  CommunityJoinRequest,
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

function isOwnerOrMod(role: RosterRole | null): boolean {
  return role === RosterRole.Owner || role === RosterRole.Mod;
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
  activeThisWeek: number; // distinct post/reply authors, last 7 days
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
}

export interface CommunityDetailDTO extends CommunityCardDTO {
  purpose: string;
  whoFor: string;
  rosterVisible: boolean;
  features: string[];
  rules: string[];
  // Resolved (`toImageUrl`) cover-image URL, or null when the community has no
  // cover. The owner's edit form seeds its `ImageUploadField` from this.
  coverImageUrl: string | null;
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
  myJoinRequestStatus: JoinRequestStatus | null;
  // A moderator takedown. Only ever surfaced to an owner/mod — outsiders get a
  // 404 for a moderated community, never this detail — so they know why the
  // community is no longer publicly reachable.
  moderationRemoved: boolean;
  moderationHidden: boolean;
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
): CommunityDetailDTO {
  return {
    ...toCommunityCard(c, stats, myRole),
    purpose: c.purpose,
    whoFor: c.whoFor,
    rosterVisible: c.rosterVisible,
    features: c.features,
    rules: c.rules,
    coverImageUrl: toImageUrl(c.coverImageUrl),
    coverCrop: cropFor(c.coverImageUrl, crops),
    owner,
    createdAt: c.createdAt.toISOString(),
    archived: c.archivedAt != null,
    frozen: c.frozenAt != null,
    myJoinRequestStatus,
    moderationRemoved: moderation?.removed ?? false,
    moderationHidden: moderation?.hidden ?? false,
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
}

/** Result of a role change on `PATCH /communities/:slug/members/:memberSlug`.
 * `slug` is the community, `memberSlug` the member whose role changed. */
export interface MemberRoleDTO {
  slug: string;
  memberSlug: string;
  role: RosterRole;
}

export interface CommunityJoinRequestDTO {
  id: string;
  member: MemberRef;
  note: string | null;
  status: JoinRequestStatus;
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
): CommunityJoinRequestDTO {
  return {
    id: request.id,
    member: memberRef,
    note: request.note,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
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
    // is lifted through the moderation/appeal path.
    canRestore: canManage && authorTombstoned && !moderationRemoved,
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
    canRestore: canManage && authorTombstoned && !moderationRemoved,
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

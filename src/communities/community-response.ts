import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
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
import {
  CommunityPostReaction,
  ReactionKey,
} from './entities/community-post-reaction.entity';
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
  owner: MemberRef | null;
  createdAt: string;
  myJoinRequestStatus: JoinRequestStatus | null;
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
): CommunityDetailDTO {
  return {
    ...toCommunityCard(c, stats, myRole),
    purpose: c.purpose,
    whoFor: c.whoFor,
    rosterVisible: c.rosterVisible,
    features: c.features,
    rules: c.rules,
    owner,
    createdAt: c.createdAt.toISOString(),
    myJoinRequestStatus,
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
 * Builds the 4-entry (one per `ReactionKey`, always present even at count 0)
 * summary for a single post from its raw reaction rows. `mine` is true iff
 * `viewerId` has a row for that key (callers pass every reaction row for the
 * post — one `IN`-batched query across a whole page, not a per-post query —
 * mirrors `EventsService.summarize`'s "single query across the page" shape).
 */
export function toReactionSummaries(
  reactionRows: Pick<CommunityPostReaction, 'key' | 'userId'>[],
  viewerId: string,
): CommunityReactionSummary[] {
  return REACTION_KEY_ORDER.map((key) => {
    const rows = reactionRows.filter((r) => r.key === key);
    return {
      key,
      count: rows.length,
      mine: rows.some((r) => r.userId === viewerId),
    };
  });
}

export function toCommunityReply(
  reply: CommunityPostReply,
  author: MemberRef | null,
  viewerId: string,
  viewerRole: RosterRole | null,
): CommunityReplyDTO {
  const deleted = reply.deletedAt != null;
  const isAuthor = reply.authorId === viewerId;
  const isMember = viewerRole != null;
  const canManage = (isAuthor || isOwnerOrMod(viewerRole)) && isMember;
  return {
    id: reply.id,
    author: deleted ? DELETED_MEMBER : author,
    text: deleted ? '' : reply.text,
    createdAt: reply.createdAt.toISOString(),
    editedAt: reply.editedAt ? reply.editedAt.toISOString() : null,
    deleted,
    canEdit: isAuthor && isMember && !deleted, // edit is author-only (owner/mod excluded)
    canDelete: canManage && !deleted,
    canRestore: canManage && deleted,
    canViewHistory: canManage && reply.editedAt != null,
  };
}

/**
 * `reactionRows` is the raw, per-post reaction rows (see
 * `toReactionSummaries`); `replies` is already `CommunityReplyDTO[]` (mapped
 * via `toCommunityReply` by the caller, which is the one that knows how to
 * resolve each reply author's `MemberRef`).
 */
export function toCommunityPost(
  post: CommunityPost,
  author: MemberRef | null,
  reactionRows: Pick<CommunityPostReaction, 'key' | 'userId'>[],
  replies: CommunityReplyDTO[],
  viewerId: string,
  viewerRole: RosterRole | null,
): CommunityPostDTO {
  const deleted = post.deletedAt != null;
  const isAuthor = post.authorId === viewerId;
  const isMember = viewerRole != null;
  const canManage = (isAuthor || isOwnerOrMod(viewerRole)) && isMember;
  return {
    id: post.id,
    author: deleted ? DELETED_MEMBER : author,
    body: deleted ? '' : post.body,
    image: deleted ? null : toImageUrl(post.image),
    kind: post.kind,
    pinned: post.pinned,
    createdAt: post.createdAt.toISOString(),
    editedAt: post.editedAt ? post.editedAt.toISOString() : null,
    deleted,
    canEdit: isAuthor && isMember && !deleted, // edit is author-only (owner/mod excluded)
    canDelete: canManage && !deleted,
    canRestore: canManage && deleted,
    canViewHistory: canManage && post.editedAt != null,
    reactions: toReactionSummaries(reactionRows, viewerId),
    replies,
    replyCount: replies.length,
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

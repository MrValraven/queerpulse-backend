import { RosterRole } from '../communities/entities/community-member.entity';
import {
  BadgeTone,
  initialsFor,
  toneFor,
} from '../admin-members/admin-members-response';

import type {
  AccountKind,
  TrustCaseKind,
  WeakVoucherReason,
} from './admin-trust-network-assessment';

export type Standing = 'trusted' | 'warned' | 'new' | 'flagged';

// One definition each: the assessment owns these unions, the DTO re-exports.
export type { AccountKind, TrustCaseKind, WeakVoucherReason };

export type JoinPathKind = 'founder' | 'invite' | 'application' | 'unknown';

/** A member as admins already see them in the drawer: slug plus display name. */
export interface TrustMemberRefDTO {
  slug: string;
  name: string;
}

export interface TrustWeakVoucherDTO extends TrustMemberRefDTO {
  reason: WeakVoucherReason;
}

export interface TrustJoinPathDTO {
  kind: JoinPathKind;
  /** The inviter (invite) or the reviewer (application). */
  bySlug: string | null;
  byName: string | null;
  /** ISO. Invite `usedAt`, request `reviewedAt`, or `joinedAt` for a founder. */
  at: string | null;
}

export interface TrustTrackRecordDTO {
  /** Distinct vouchees ever, active and withdrawn. */
  vouchesGiven: number;
  /** Of those, the ones currently suspended or with standing `flagged`. */
  laterFlaggedCount: number;
}

export interface TrustNodeDTO {
  id: string;
  /** The member's real account id (`User.id`). It differs from `id`/`slug`
   *  above, which are the profile slug used as the graph's node key. Admin
   *  actions that address the account directly (e.g. verifying a member)
   *  need this one. */
  userId: string;
  slug: string;
  name: string;
  pronouns: string | null;
  initials: string;
  tone: BadgeTone;
  avatarUrl: string | null;
  joinedAt: string;
  standing: Standing;
  /** ADM-23: true when this node belongs to a ring the platform-wide
   *  assessment found (a closed self-vouching loop among new, unverified
   *  accounts). A graph-structure signal separate from `standing`, which keeps
   *  its own meaning (suspended/frozen/high-report-count). */
  inRing: boolean;
  /** Primary community; `sceneIds[0]` when the member has any. */
  sceneId: string | null;
  role: string | null;
  openReportCount: number;
  verified: boolean;
  private: boolean;
  accountKind: AccountKind;
  ringId: string | null;
  /** The weak active inbound vouchers. Empty when the member is not isolated. */
  isolatedBy: TrustWeakVoucherDTO[];
  joinPath: TrustJoinPathDTO;
  trackRecord: TrustTrackRecordDTO;
  /** Platform-wide counts, across every member. */
  activeInboundCount: number;
  activeOutboundCount: number;
  /** Every top-level community, primary first. */
  sceneIds: string[];
}

export interface TrustEdgeDTO {
  id: string;
  from: string;
  to: string;
  mutual: boolean;
  withdrawn: boolean;
  createdAt: string;
  relationship: string | null;
  note: string | null;
  anonymous: boolean;
  kind: 'invite' | 'vouch';
}

export interface SceneDTO {
  id: string;
  label: string;
  color: string;
}

export interface TrustRingDTO {
  /** `ring:${alphabetically first member slug}` */
  id: string;
  /** The full ring, members outside the returned view included. */
  memberSlugs: string[];
  memberCount: number;
  /** ISO, earliest member joinedAt. */
  firstJoinedAt: string;
  lastJoinedAt: string;
  /** Members outside the ring vouching for 2+ ring members. */
  sharedVouchers: TrustMemberRefDTO[];
}

export interface TrustCaseDTO {
  /** Ring id, `isolated:${slug}` or `flagged:${slug}`. */
  id: string;
  kind: TrustCaseKind;
  /** Who the graph focuses on when the case is clicked. */
  subjectSlug: string;
  subjectName: string;
  ringId: string | null;
  /** Ring size; 1 for the other kinds. */
  memberCount: number;
  /** Isolated cases only; 0 for the other kinds. */
  weakVoucherCount: number;
  openReportCount: number;
  /** Ring cases only: ceil((last - first joinedAt) / 1h). */
  windowHours: number | null;
  score: number;
}

export interface TrustNetworkDTO {
  nodes: TrustNodeDTO[];
  edges: TrustEdgeDTO[];
  /** Every community named in any node's `sceneIds`. */
  scenes: SceneDTO[];
  truncated: boolean;
  /** Rings with at least one member in `nodes`. */
  rings: TrustRingDTO[];
  /** Platform-wide, top `CASES_LIMIT` by score. */
  cases: TrustCaseDTO[];
  /** Platform-wide total. */
  openCaseCount: number;
  /** ISO */
  platformStartedAt: string;
  newAccountWindowDays: number;
}

/** `GET /admin/trust-network/summary`: the members page badge and entry point,
 *  served without loading the graph. */
export interface TrustNetworkSummaryDTO {
  openCaseCount: number;
  /** Top case subject, else the earliest-joined founder or staff slug, else null. */
  entrySlug: string | null;
}

/** One typeahead result from `GET /admin/trust-network/search`: enough to
 *  render a picker row and jump the graph to `slug` (ADM-10). */
export interface TrustNetworkMemberSearchResultDTO {
  slug: string;
  name: string;
  initials: string;
  avatarUrl: string | null;
}

/** Standing precedence: flagged > warned > new > trusted. A member suspended
 *  or frozen, or carrying ≥2 open reports, reads as flagged; ≥1 open report is
 *  a warning; an unverified account with no reports is new; else trusted. */
export function standingFor(input: {
  suspended: boolean;
  frozen: boolean;
  openReportCount: number;
  verified: boolean;
}): Standing {
  if (input.suspended || input.frozen || input.openReportCount >= 2) {
    return 'flagged';
  }
  if (input.openReportCount >= 1) return 'warned';
  if (!input.verified) return 'new';
  return 'trusted';
}

// Only the ORDER matters here (highest role wins the "primary community"
// tie-break), so adding `co_owner` re-based the numbers and kept every
// relative ranking that already existed. A co-owner holds owner-level
// powers inside the community and so outranks a mod, while the community's one
// accountable owner of record still outranks them.
const ROLE_RANK: Record<RosterRole, number> = {
  [RosterRole.Owner]: 4,
  [RosterRole.CoOwner]: 3,
  [RosterRole.Mod]: 2,
  [RosterRole.Member]: 1,
};

export interface CommunityMembershipInput {
  communityId: string;
  communityName: string;
  role: RosterRole;
  communitySize: number;
}

/** Every membership ordered primary first: highest role, tie-break by
 *  community size desc then id. Returns a new array. */
export function orderMembershipsPrimaryFirst(
  memberships: CommunityMembershipInput[],
): CommunityMembershipInput[] {
  return [...memberships].sort((first, second) => {
    const rankDifference = ROLE_RANK[second.role] - ROLE_RANK[first.role];
    if (rankDifference !== 0) return rankDifference;
    const sizeDifference = second.communitySize - first.communitySize;
    if (sizeDifference !== 0) return sizeDifference;
    return first.communityId.localeCompare(second.communityId);
  });
}

/** Primary community = the first of `orderMembershipsPrimaryFirst`.
 *  Returns null when the member is in no community. */
export function sceneFor(
  memberships: CommunityMembershipInput[],
): { id: string; label: string; role: RosterRole } | null {
  if (!memberships.length) return null;
  const best = orderMembershipsPrimaryFirst(memberships)[0];
  if (best === undefined) return null;
  return { id: best.communityId, label: best.communityName, role: best.role };
}

/** owner/mod/member label for the node's `role` field, from its primary scene. */
export function roleLabelFor(role: RosterRole | null): string | null {
  if (role === RosterRole.Owner) return 'owner';
  if (role === RosterRole.Mod) return 'mod';
  if (role === RosterRole.Member) return 'member';
  return null;
}

const SCENE_COLORS = [
  'var(--jade)',
  'var(--violet)',
  'var(--accent)',
  'var(--amber)',
  'var(--plum)',
  'var(--rose)',
];

/** Assigns a stable palette color per distinct scene id, round-robin over the
 *  ids sorted for determinism. */
export function buildScenes(sceneById: Map<string, string>): SceneDTO[] {
  const ids = [...sceneById.keys()].sort();
  return ids.map((id, index) => ({
    id,
    label: sceneById.get(id) ?? id,
    // invariant: `index % SCENE_COLORS.length` is always a valid index of the
    // non-empty SCENE_COLORS constant.
    color: SCENE_COLORS[index % SCENE_COLORS.length]!,
  }));
}

export { initialsFor, toneFor };
export type { BadgeTone };

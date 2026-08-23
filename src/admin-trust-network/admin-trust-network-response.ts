import { RosterRole } from '../communities/entities/community-member.entity';
import {
  BadgeTone,
  initialsFor,
  toneFor,
} from '../admin-members/admin-members-response';

export type Standing = 'trusted' | 'warned' | 'new' | 'flagged';

export interface TrustNodeDTO {
  id: string;
  /** The member's real account id (`User.id`) — distinct from `id`/`slug`
   *  above, which are the profile slug used as the graph's node key. Admin
   *  actions that address the account directly (e.g. verifying a member)
   *  need this, not the slug. */
  userId: string;
  slug: string;
  name: string;
  pronouns: string | null;
  initials: string;
  tone: BadgeTone;
  avatarUrl: string | null;
  joinedAt: string;
  standing: Standing;
  /** ADM-23: real cycle detection (`detectRingSlugs`) — true when this node
   *  is part of a closed self-vouching loop among new/unverified accounts.
   *  A graph-structure signal distinct from `standing`, which keeps its own
   *  meaning (suspended/frozen/high-report-count). */
  inRing: boolean;
  sceneId: string | null;
  role: string | null;
  openReportCount: number;
  verified: boolean;
  private: boolean;
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

export interface TrustNetworkDTO {
  nodes: TrustNodeDTO[];
  edges: TrustEdgeDTO[];
  scenes: SceneDTO[];
  truncated: boolean;
}

/** One typeahead result from `GET /admin/trust-network/search` — enough to
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
// tie-break), so adding `co_owner` re-based the numbers rather than changing
// any relative ranking that already existed. A co-owner holds owner-level
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

/** Primary community = highest role, tie-break by community size desc then id.
 *  Returns null when the member is in no community. */
export function sceneFor(
  memberships: CommunityMembershipInput[],
): { id: string; label: string; role: RosterRole } | null {
  if (!memberships.length) return null;
  const best = [...memberships].sort((a, b) => {
    const rankDiff = ROLE_RANK[b.role] - ROLE_RANK[a.role];
    if (rankDiff !== 0) return rankDiff;
    const sizeDiff = b.communitySize - a.communitySize;
    if (sizeDiff !== 0) return sizeDiff;
    return a.communityId.localeCompare(b.communityId);
  })[0];
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
  'var(--coral)',
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

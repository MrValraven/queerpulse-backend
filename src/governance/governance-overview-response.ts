import { MemberRef } from '../common/member-ref';
import {
  GovernanceOverview,
  OverviewAuthoredText,
  OverviewDecision,
  OverviewHealthStat,
  OverviewModerationStep,
  OverviewPrinciple,
} from './entities/governance-overview.entity';

/**
 * One advisory-council seat on the wire. The stored seat holds a `memberId`
 * and nothing else about the person; the reader gets the resolved `member`
 * instead, so the name and face on the public accountability page are the ones
 * on that person's profile right now rather than a copy taken whenever an admin
 * last typed them.
 *
 * `member.avatarUrl` is already gated by `toMemberRef` on the member's own
 * "show your photo" toggle, so a seat-holder who hides their face falls back to
 * the `tint` monogram here exactly as they do everywhere else.
 *
 * A seat whose member no longer resolves (deleted account, no profile row)
 * never reaches this shape: `GovernanceOverviewService` drops it from the
 * public array rather than render a seat with a hole where a person was.
 */
export interface CouncilSeatResponseDTO {
  member: MemberRef;
  roleKey?: string;
  role?: OverviewAuthoredText;
  tint: 'jade' | 'violet' | 'plum';
}

export interface GovernanceOverviewResponseDTO {
  health: OverviewHealthStat[];
  moderationSteps: OverviewModerationStep[];
  council: CouncilSeatResponseDTO[];
  principles: OverviewPrinciple[];
  decisions: OverviewDecision[];
  /** ISO-8601 timestamp of the last publish (P3-7), or `null` if never
   *  published. Lets the public governance page render a "last published" line. */
  publishedAt: string | null;
}

/** Response for `POST /admin/governance/publish` (P3-7). */
export interface GovernancePublishResponseDTO {
  publishedAt: string;
}

/**
 * Maps the singleton entity → response by hand (no global serializer; per repo
 * convention every endpoint maps explicitly or leaks columns). Drops `id` and
 * `updatedAt` — the frontend needs neither.
 *
 * `council` is passed in rather than read off the entity: seats name members,
 * and resolving those names is a database read this pure mapper has no place
 * doing. The caller (`GovernanceOverviewService`) batches it.
 */
export function toGovernanceOverviewResponse(
  overview: GovernanceOverview,
  council: CouncilSeatResponseDTO[],
): GovernanceOverviewResponseDTO {
  return {
    health: overview.health,
    moderationSteps: overview.moderationSteps,
    council,
    principles: overview.principles,
    decisions: overview.decisions,
    publishedAt: overview.publishedAt
      ? overview.publishedAt.toISOString()
      : null,
  };
}

import { Repository } from 'typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { RoadmapVote, RoadmapVoteTarget } from './entities/roadmap-vote.entity';
import { AdminVoteBreakdownDTO } from './roadmap-admin-response';

/** How many communities surface by name before the rest fold into `other`. */
const TOP_COMMUNITIES_PER_TARGET = 2;

/**
 * Per-target (item or idea) "which communities are asking for this"
 * breakdown for the admin drawer's Votes section — the top 2 communities by
 * voter count, the rest (including voters with no community membership)
 * folded into `other`.
 *
 * Batched: exactly TWO queries total, regardless of how many `targetIds` are
 * passed — never one query per target (see `RoadmapAdminService.getAdmin`'s
 * no-N+1 requirement, same posture as `liveVoteCounts` in this module).
 *
 * A voter is attributed to at most ONE community — their EARLIEST membership
 * — so a member who belongs to several communities can't inflate more than
 * one bucket, and `other` can never go negative. A voter with no community
 * membership at all falls straight into `other`.
 *
 * A target with zero votes is simply absent from the returned map — callers
 * `?? { top: [], other: 0 }` the lookup, same convention as `liveVoteCounts`.
 */
export async function computeVoteBreakdown(
  votes: Repository<RoadmapVote>,
  communityMembers: Repository<CommunityMember>,
  targetType: RoadmapVoteTarget,
  targetIds: string[],
): Promise<Map<string, AdminVoteBreakdownDTO>> {
  const result = new Map<string, AdminVoteBreakdownDTO>();
  if (targetIds.length === 0) return result;

  const voteRows = await votes
    .createQueryBuilder('vote')
    .select('vote.targetId', 'targetId')
    .addSelect('vote.memberId', 'memberId')
    .where('vote.targetType = :targetType', { targetType })
    .andWhere('vote.targetId IN (:...targetIds)', { targetIds })
    // Deterministic row order — without it Postgres is free to return these
    // in any order, which would make which community wins a count tie (see
    // the `.sort()` below) vary run to run.
    .orderBy('vote.createdAt', 'ASC')
    .addOrderBy('vote.id', 'ASC')
    .getRawMany<{ targetId: string; memberId: string }>();
  if (voteRows.length === 0) return result;

  // One representative community per voter — their earliest membership.
  // Restricted to the voters who actually voted on one of `targetIds`
  // (`memberIds`, not the whole platform), so this stays cheap regardless of
  // `community_members`' total size.
  const memberIds = [...new Set(voteRows.map((row) => row.memberId))];
  const membershipRows = await communityMembers
    .createQueryBuilder('member')
    .innerJoin(Community, 'community', 'community.id = member.community_id')
    .select('member.user_id', 'userId')
    .addSelect('community.name', 'communityName')
    .where('member.user_id IN (:...memberIds)', { memberIds })
    .orderBy('member.user_id', 'ASC')
    .addOrderBy('member.joined_at', 'ASC')
    .getRawMany<{ userId: string; communityName: string }>();

  // First row per `userId` wins (rows are already ordered earliest-first).
  const communityByMember = new Map<string, string>();
  for (const row of membershipRows) {
    if (!communityByMember.has(row.userId)) {
      communityByMember.set(row.userId, row.communityName);
    }
  }

  const totalsByTarget = new Map<string, number>();
  const countsByTarget = new Map<string, Map<string, number>>();
  for (const row of voteRows) {
    totalsByTarget.set(
      row.targetId,
      (totalsByTarget.get(row.targetId) ?? 0) + 1,
    );
    const communityName = communityByMember.get(row.memberId);
    if (!communityName) continue;
    let counts = countsByTarget.get(row.targetId);
    if (!counts) {
      counts = new Map<string, number>();
      countsByTarget.set(row.targetId, counts);
    }
    counts.set(communityName, (counts.get(communityName) ?? 0) + 1);
  }

  for (const [targetId, total] of totalsByTarget) {
    const counts = countsByTarget.get(targetId);
    if (!counts) {
      result.set(targetId, { top: [], other: total });
      continue;
    }
    const top = [...counts.entries()]
      .sort((first, second) => {
        // Highest count first; ties break alphabetically by community name
        // so the result is fully deterministic regardless of row/Map
        // iteration order.
        if (second[1] !== first[1]) return second[1] - first[1];
        return first[0].localeCompare(second[0]);
      })
      .slice(0, TOP_COMMUNITIES_PER_TARGET)
      .map(([communityName, count]) => ({ communityName, count }));
    const attributed = top.reduce((sum, entry) => sum + entry.count, 0);
    result.set(targetId, { top, other: total - attributed });
  }

  return result;
}

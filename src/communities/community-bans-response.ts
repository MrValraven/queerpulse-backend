import { MemberRef } from '../common/member-ref';
import { CommunityBan } from './entities/community-ban.entity';

/**
 * `GET /communities/:slug/bans` — one entry on a community's ban list, for
 * that community's owner, co-owners and moderators. Hand-mapped from
 * `CommunityBan` (no global serializer in this repo), so the raw `userId` and
 * `bannedByUserId` columns never leave the server: both are resolved to the
 * compact `MemberRef` every other community response embeds.
 *
 * `member` is null when the banned account has since been erased, and
 * `bannedBy` is null when the moderator who applied the ban has (their FK is
 * `ON DELETE SET NULL` precisely so the ban outlives them). A null `bannedBy`
 * reads as "the moderator who did this is gone", and the ban still stands.
 *
 * `reason` is the moderator's own note, shown here because this list exists to
 * answer "why is this person barred" for the people who have to decide whether
 * to lift it.
 */
export interface CommunityBanDTO {
  id: string;
  member: MemberRef | null;
  bannedBy: MemberRef | null;
  reason: string | null;
  createdAt: string;
}

export function toCommunityBanDTO(
  ban: CommunityBan,
  member: MemberRef | null,
  bannedBy: MemberRef | null,
): CommunityBanDTO {
  return {
    id: ban.id,
    member,
    bannedBy,
    reason: ban.reason,
    createdAt: ban.createdAt.toISOString(),
  };
}

/** The whole ban list for one community, newest ban first. */
export interface CommunityBanListDTO {
  bans: CommunityBanDTO[];
  total: number;
}

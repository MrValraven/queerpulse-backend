import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { RecognitionPerkClaim } from './entities/recognition-perk-claim.entity';
import { RecognitionStat } from './entities/recognition-stat.entity';
import {
  INVITE_QUOTA_PERKS,
  inviteQuotaBonusForLevel,
} from './recognition.catalog';
import { computeLevel } from './recognition-response';

/**
 * The one rule for the claimed invite-quota perk bonus, shared by the single
 * and batched lookups below so the two cannot drift: the highest bonus among
 * the quota perks the member has claimed AND whose unlock level they still
 * hold. 0 when no claimed perk qualifies.
 */
export function inviteQuotaBonusFromClaims(
  level: number,
  claimedPerkKeys: ReadonlySet<string>,
): number {
  let bonus = 0;
  for (const perk of INVITE_QUOTA_PERKS) {
    if (!claimedPerkKeys.has(perk.key)) continue;
    if (level < perk.unlockLevel) continue;
    bonus = Math.max(bonus, inviteQuotaBonusForLevel(perk.unlockLevel));
  }
  return bonus;
}

/**
 * What a member's recognition actually ENTITLES them to, for the services
 * outside this module that enforce it (SUS-04).
 *
 * Deliberately tiny and dependency-free: it holds two repositories and no
 * other provider, and lives in its own `RecognitionEntitlementsModule` so
 * `MembershipModule` can import it without pulling in
 * `RecognitionModule` -> `ProfilesModule` / `PublicEligibilityModule` /
 * `NotificationsModule` (and `AuthModule` already imports `MembershipModule`,
 * so that would be a cycle waiting to happen). Same pattern as
 * `CommunityMembershipModule` and `ListingLookupModule`.
 */
@Injectable()
export class RecognitionEntitlementsService {
  constructor(
    @InjectRepository(RecognitionStat)
    private readonly stats: Repository<RecognitionStat>,
    @InjectRepository(RecognitionPerkClaim)
    private readonly perkClaims: Repository<RecognitionPerkClaim>,
  ) {}

  /**
   * The member's current level, derived server-side from their stored XP
   * total. Never accept a level from a client: this is the only place outside
   * `recognition-response.ts` that decides what level someone is.
   */
  async getLevel(userId: string): Promise<number> {
    const stat = await this.stats.findOne({ where: { userId } });
    return computeLevel(stat?.xp ?? 0).level;
  }

  /**
   * Extra monthly invites this member has earned AND claimed, added to the
   * base quota by `InvitesService.resolveMonthlyLimit`. Returns 0 for a member
   * below the first rung, or one who has never pressed claim.
   *
   * Both conditions are checked. The claim row is what the member opted into,
   * and the level is re-derived here rather than trusted from the claim's
   * existence, so a future change to the ladder (or to `unlockLevel`) cannot
   * leave a stale claim granting a bonus the member no longer qualifies for.
   */
  async getInviteQuotaBonus(userId: string): Promise<number> {
    const quotaPerkKeys = INVITE_QUOTA_PERKS.map((perk) => perk.key);
    if (quotaPerkKeys.length === 0) return 0;
    const [level, claims] = await Promise.all([
      this.getLevel(userId),
      this.perkClaims.find({
        where: { userId, perkKey: In(quotaPerkKeys) },
      }),
    ]);
    const claimedKeys = new Set(claims.map((claim) => claim.perkKey));
    return inviteQuotaBonusFromClaims(level, claimedKeys);
  }

  /**
   * `getInviteQuotaBonus` for many members at once: one stats read and one
   * claims read for the whole set, then the same `inviteQuotaBonusFromClaims`
   * rule per member. Every requested id is in the map, at 0 when nothing
   * qualifies. Backs the admin invite quotas list.
   */
  async getInviteQuotaBonusForUserIds(
    userIds: string[],
  ): Promise<Map<string, number>> {
    const bonusByUserId = new Map<string, number>();
    const uniqueUserIds = [...new Set(userIds)];
    if (!uniqueUserIds.length) return bonusByUserId;
    const quotaPerkKeys = INVITE_QUOTA_PERKS.map((perk) => perk.key);
    if (quotaPerkKeys.length === 0) {
      for (const userId of uniqueUserIds) bonusByUserId.set(userId, 0);
      return bonusByUserId;
    }
    const [stats, claims] = await Promise.all([
      this.stats.find({
        where: { userId: In(uniqueUserIds) },
        select: ['userId', 'xp'],
      }),
      this.perkClaims.find({
        where: { userId: In(uniqueUserIds), perkKey: In(quotaPerkKeys) },
        select: ['id', 'userId', 'perkKey'],
      }),
    ]);
    const xpByUserId = new Map(stats.map((stat) => [stat.userId, stat.xp]));
    const claimedKeysByUserId = new Map<string, Set<string>>();
    for (const claim of claims) {
      const claimedKeys = claimedKeysByUserId.get(claim.userId) ?? new Set();
      claimedKeys.add(claim.perkKey);
      claimedKeysByUserId.set(claim.userId, claimedKeys);
    }
    for (const userId of uniqueUserIds) {
      const level = computeLevel(xpByUserId.get(userId) ?? 0).level;
      bonusByUserId.set(
        userId,
        inviteQuotaBonusFromClaims(
          level,
          claimedKeysByUserId.get(userId) ?? new Set(),
        ),
      );
    }
    return bonusByUserId;
  }
}

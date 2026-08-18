import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RecognitionStat } from './entities/recognition-stat.entity';
import { RecognitionAward } from './entities/recognition-award.entity';
import { Profile } from '../users/entities/profile.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { SavedItem, SavedKind } from '../saved/entities/saved-item.entity';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { PublicEligibilityService } from '../public-eligibility/public-eligibility.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { UserStatus } from '../users/entities/user.entity';
import { computeLevel } from './recognition-response';
import { BADGE_CATALOG, levelName } from './recognition.catalog';
import {
  RecognitionSignals,
  scoreSignals,
  badgeBonusXp,
  qualifyingBadgeKeys,
} from './recognition.scoring';

const RECOMPUTE_TTL_MS = 5 * 60 * 1000;

export interface RecomputeResult {
  xpBefore: number;
  xpAfter: number;
  levelBefore: number;
  levelAfter: number;
  newBadgeKeys: string[];
}

/**
 * Derives XP from live signals, awards badges idempotently, materializes
 * `recognition_stats.xp` with a no-regression floor, and emits level-up and
 * badge-earned notifications. The heart of recognition (spec §3 Tier 2).
 */
@Injectable()
export class RecognitionAwardingService {
  private readonly logger = new Logger(RecognitionAwardingService.name);

  constructor(
    @InjectRepository(RecognitionStat)
    private readonly stats: Repository<RecognitionStat>,
    @InjectRepository(RecognitionAward)
    private readonly awards: Repository<RecognitionAward>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
    @InjectRepository(MemberPreferences)
    private readonly memberPreferences: Repository<MemberPreferences>,
    private readonly eligibility: PublicEligibilityService,
    private readonly notifications: NotificationsService,
  ) {}

  async recompute(
    user: CurrentUserData,
    options: { force?: boolean } = {},
  ): Promise<RecomputeResult> {
    const userId = user.userId;
    const stat = await this.stats.findOne({ where: { userId } });
    const xpBefore = stat?.xp ?? 0;
    const levelBefore = computeLevel(xpBefore).level;

    const fresh =
      stat && Date.now() - stat.updatedAt.getTime() < RECOMPUTE_TTL_MS;
    if (!options.force && fresh) {
      return {
        xpBefore,
        xpAfter: xpBefore,
        levelBefore,
        levelAfter: levelBefore,
        newBadgeKeys: [],
      };
    }

    const signals = await this.gatherSignals(user);
    const qualifying = qualifyingBadgeKeys(signals);
    const existing = await this.awards.find({ where: { userId } });
    const existingKeys = new Set(existing.map((award) => award.badgeKey));
    const newBadgeKeys = qualifying.filter((key) => !existingKeys.has(key));

    if (newBadgeKeys.length > 0) {
      // Idempotent: the (user_id, badge_key) unique index makes ON CONFLICT
      // DO NOTHING safe even under a concurrent recompute.
      await this.awards
        .createQueryBuilder()
        .insert()
        .values(
          newBadgeKeys.map((badgeKey) => ({
            userId,
            badgeKey,
            context:
              BADGE_CATALOG.find((badge) => badge.key === badgeKey)
                ?.earnedContext ?? null,
          })),
        )
        .orIgnore()
        .execute();
    }

    // Badges are sticky: held = everything previously earned plus the new ones,
    // even if a signal has since dropped below threshold.
    const heldKeys = new Set<string>([...existingKeys, ...newBadgeKeys]);
    const computedXp = scoreSignals(signals) + badgeBonusXp(heldKeys);

    // Atomic GREATEST upsert: the DB resolves max(stored, computed), so
    // concurrent recomputes cannot lose an update. Level-up delta uses the
    // pre-read xpBefore; under rare concurrency two recomputes could both
    // emit a level-up notification, an accepted cosmetic tradeoff.
    const [row] = await this.stats.query<{ xp: number | string }[]>(
      `INSERT INTO recognition_stats (user_id, xp, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE
         SET xp = GREATEST(recognition_stats.xp, EXCLUDED.xp), updated_at = now()
       RETURNING xp`,
      [userId, computedXp],
    );
    const xpAfter = Number(row!.xp);
    const levelAfter = computeLevel(xpAfter).level;

    await this.emitNotifications(userId, levelBefore, levelAfter, newBadgeKeys);

    return { xpBefore, xpAfter, levelBefore, levelAfter, newBadgeKeys };
  }

  /**
   * Event-listener entry point: the listener only has a userId, not a full
   * `CurrentUserData`. `PublicEligibilityService.getSignals` reads only
   * `user.userId` off the argument; `user.status` feeds `standingOk`, a field
   * `gatherSignals` above never reads, and `user.role` is unused entirely. A
   * synthetic active user is therefore safe and avoids an extra user lookup.
   * Defaults to non-forced so this stays bounded by the same 5-minute TTL as
   * the on-read path, even under a burst of high-signal events.
   */
  async recomputeByUserId(
    userId: string,
    options: { force?: boolean } = {},
  ): Promise<RecomputeResult> {
    const user: CurrentUserData = {
      userId,
      email: '',
      status: UserStatus.Active,
      role: '',
    };
    return this.recompute(user, options);
  }

  private async gatherSignals(
    user: CurrentUserData,
  ): Promise<RecognitionSignals> {
    const [
      signalsDto,
      profile,
      communitiesJoined,
      listingsSaved,
      articlesSaved,
      preferences,
    ] = await Promise.all([
      this.eligibility.getSignals(user),
      this.profiles.findOne({ where: { userId: user.userId } }),
      this.communityMembers.count({ where: { userId: user.userId } }),
      this.savedItems.count({
        where: { userId: user.userId, subjectType: SavedKind.Listing },
      }),
      this.savedItems.count({
        where: { userId: user.userId, subjectType: SavedKind.Article },
      }),
      this.memberPreferences.findOne({ where: { userId: user.userId } }),
    ]);

    const workProfileComplete =
      (preferences?.skills.length ?? 0) > 0 &&
      (preferences?.focusAreas.length ?? 0) > 0;

    const profileComplete =
      Boolean(profile?.avatarUrl) && (profile?.bio?.trim().length ?? 0) > 0;

    const stepsDone = [
      profileComplete,
      communitiesJoined > 0,
      signalsDto.publishedSubprofiles > 0,
      signalsDto.vouchesGivenCount > 0,
      signalsDto.connectionCount > 0,
      signalsDto.communityPosts > 0,
    ];
    const gettingStartedStepsDone = stepsDone.filter(Boolean).length;

    return {
      profileComplete,
      communitiesJoined,
      personasPublished: signalsDto.publishedSubprofiles,
      // `vouchCount` here means "vouches this member has GIVEN", mirroring the
      // getting-started step ("vouch for someone else") and matching the
      // frontend's `useGettingStarted.ts`, which reads the same outbound
      // field for the identical reason (inbound `vouchCount` is denormalized
      // on Profile and ticks itself for an invite-vouched member who has
      // never vouched for anyone).
      vouchCount: signalsDto.vouchesGivenCount,
      connectionCount: signalsDto.connectionCount,
      eventsAttended: signalsDto.eventsAttended,
      communityPosts: signalsDto.communityPosts,
      endorsementCount: signalsDto.endorsementCount,
      workshopsTaught: signalsDto.workshopsTaught,
      tenureDays: signalsDto.tenureDays,
      verified: signalsDto.verified,
      gettingStartedStepsDone,
      gettingStartedComplete: gettingStartedStepsDone === stepsDone.length,
      listingsSaved,
      articlesSaved,
      workProfileComplete,
    };
  }

  private async emitNotifications(
    userId: string,
    levelBefore: number,
    levelAfter: number,
    newBadgeKeys: string[],
  ): Promise<void> {
    if (levelAfter > levelBefore) {
      try {
        await this.notifications.create(userId, NotificationType.XpLevelUp, {
          level: levelAfter,
          name: levelName(levelAfter),
        });
      } catch (error) {
        this.logger.warn(`level-up notification failed: ${String(error)}`);
      }
    }
    for (const badgeKey of newBadgeKeys) {
      const entry = BADGE_CATALOG.find((badge) => badge.key === badgeKey);
      try {
        await this.notifications.create(userId, NotificationType.BadgeEarned, {
          badgeKey,
          badgeName: entry?.name ?? badgeKey,
        });
      } catch (error) {
        this.logger.warn(`badge notification failed: ${String(error)}`);
      }
    }
  }
}

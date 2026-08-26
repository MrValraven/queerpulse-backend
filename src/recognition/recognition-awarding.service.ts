import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { RecognitionStat } from './entities/recognition-stat.entity';
import { RecognitionAward } from './entities/recognition-award.entity';
import { RecognitionLedgerEntry } from './entities/recognition-ledger-entry.entity';
import { Profile } from '../users/entities/profile.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { SavedItem, SavedKind } from '../saved/entities/saved-item.entity';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { ListingPublicQuestion } from '../listings/entities/listing-public-question.entity';
import {
  ResourceSuggestion,
  ResourceSuggestionStatus,
} from '../resources/entities/resource-suggestion.entity';
import { VolunteerSignup } from '../volunteering/entities/volunteer-signup.entity';
import { PublicEligibilityService } from '../public-eligibility/public-eligibility.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { UserStatus } from '../users/entities/user.entity';
import { computeLevel } from './recognition-response';
import { BADGE_CATALOG, levelName } from './recognition.catalog';
import {
  BADGE_BONUS_BY_RARITY,
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
 *
 * Two properties of `recompute` are deliberate design, not oversights
 * (BE-COM-24 raised both):
 *
 *   1. **XP is monotonic.** The upsert resolves
 *      `GREATEST(stored, computed)`, so a withdrawn vouch, a deleted post or
 *      a moderation takedown never lowers a member's score. Recognition here
 *      is a record of what someone has contributed, not a live gauge of what
 *      currently exists — taking XP back for a post that was later removed
 *      would make the number feel punitive and unstable. Changing this is a
 *      product decision, and it would need a matching answer for the ledger
 *      (which only ever appends positive rows).
 *   2. **Event listeners do not force a recompute.** `recomputeByUserId`
 *      defaults to non-forced so listener-driven recomputes stay bounded by
 *      the same `RECOMPUTE_TTL_MS` window as the on-read path; a burst of
 *      high-signal events would otherwise trigger one full cross-domain
 *      signal gather each. The cost is that a member's XP can lag an action
 *      by up to five minutes, which the on-read recompute then closes.
 *
 * What was NOT deliberate, and is fixed: the ledger double-count under
 * concurrent recomputes — see the lock in `recompute`.
 */
@Injectable()
export class RecognitionAwardingService {
  private readonly logger = new Logger(RecognitionAwardingService.name);

  constructor(
    // The only injected repository this service still holds: `recompute`'s
    // whole read-modify-write runs through `stats.manager.transaction(...)`
    // under a per-member advisory lock (BE-COM-24), so awards and ledger rows
    // are written through that transaction's `EntityManager` rather than
    // through separate, unsynchronized repositories.
    @InjectRepository(RecognitionStat)
    private readonly stats: Repository<RecognitionStat>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
    @InjectRepository(MemberPreferences)
    private readonly memberPreferences: Repository<MemberPreferences>,
    // ── the contribution side (SUS-05) ──────────────────────────────────────
    // Three counts that have no home in `PublicEligibilityService` (they are
    // not eligibility signals) and so are read here directly. The other two
    // contribution signals, `piecesPublished` and `eventsHosted`, come off
    // the eligibility DTO, which already computed both and simply never
    // handed them to recognition.
    @InjectRepository(VolunteerSignup)
    private readonly volunteerSignups: Repository<VolunteerSignup>,
    @InjectRepository(ListingPublicQuestion)
    private readonly listingQuestions: Repository<ListingPublicQuestion>,
    @InjectRepository(ResourceSuggestion)
    private readonly resourceSuggestions: Repository<ResourceSuggestion>,
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

    // Signals are read outside the lock below: they are the expensive part
    // (a dozen cross-domain counts) and are only ever an input, never a
    // read-modify-write.
    const signals = await this.gatherSignals(user);
    const qualifying = qualifyingBadgeKeys(signals);

    // Everything from here on is a read-modify-write against this member's
    // recognition state, and it runs under a per-member transaction-scoped
    // advisory lock (BE-COM-24).
    //
    // Without it, two overlapping recomputes (an event listener and a page
    // read) both read the same stale `xpBefore`, both upsert, and both append
    // a "Recognition recalculated from recent activity" ledger row for the
    // same delta — so the ledger's running total drifted above the stat it is
    // supposed to explain. The same race duplicated the per-badge ledger rows,
    // because both passes computed the same `newBadgeKeys` before either
    // insert landed (`orIgnore` de-duplicates the AWARD, not the ledger row).
    //
    // An advisory lock rather than `SELECT ... FOR UPDATE` on
    // `recognition_stats`: a member's first-ever recompute has no row to lock,
    // which is exactly when both passes see `xpBefore = 0` and double-count
    // the whole balance. `hashtextextended(userId, 0)` maps the uuid onto the
    // bigint key the advisory-lock functions take; a hash collision between
    // two members costs a little needless serialization and nothing else.
    // `pg_advisory_xact_lock` releases on commit or rollback, so no unlock
    // path can be missed.
    const {
      xpBefore: lockedXpBefore,
      xpAfter,
      newBadgeKeys,
    } = await this.stats.manager.transaction(async (manager) => {
      await manager.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [userId],
      );

      const awardsRepo = manager.getRepository(RecognitionAward);
      const existing = await awardsRepo.find({ where: { userId } });
      const existingKeys = new Set(existing.map((award) => award.badgeKey));
      const earnedKeys = qualifying.filter((key) => !existingKeys.has(key));

      if (earnedKeys.length > 0) {
        // Idempotent: the (user_id, badge_key) unique index makes ON CONFLICT
        // DO NOTHING safe even were a writer to slip past the lock.
        await awardsRepo
          .createQueryBuilder()
          .insert()
          .values(
            earnedKeys.map((badgeKey) => ({
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

      // Badges are sticky: held = everything previously earned plus the new
      // ones, even if a signal has since dropped below threshold.
      const heldKeys = new Set<string>([...existingKeys, ...earnedKeys]);
      const computedXp = scoreSignals(signals) + badgeBonusXp(heldKeys);

      // Re-read the stored XP under the lock. The value read before the
      // lock (`xpBefore` above, used only for the TTL check) may be stale by
      // now — that staleness is what used to double-count the delta.
      const [current] = await manager.query<{ xp: number | string }[]>(
        `SELECT xp FROM recognition_stats WHERE user_id = $1`,
        [userId],
      );
      const lockedBefore = current ? Number(current.xp) : 0;

      // GREATEST upsert: `recognition_stats.xp` is deliberately a
      // no-regression floor — see the note on `recompute`'s contract. The
      // lock, not GREATEST, is what makes the delta correct.
      const [row] = await manager.query<{ xp: number | string }[]>(
        `INSERT INTO recognition_stats (user_id, xp, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (user_id) DO UPDATE
             SET xp = GREATEST(recognition_stats.xp, EXCLUDED.xp), updated_at = now()
           RETURNING xp`,
        [userId, computedXp],
      );
      const after = Number(row!.xp);

      // Inside the transaction, so the ledger rows commit (or roll back)
      // with the stat they explain.
      await this.writeLedgerEntries(
        manager,
        userId,
        lockedBefore,
        after,
        earnedKeys,
      );

      return {
        xpBefore: lockedBefore,
        xpAfter: after,
        newBadgeKeys: earnedKeys,
      };
    });

    // Level transition is measured from the locked pre-value, so a member can
    // only ever be told they levelled up once.
    const lockedLevelBefore = computeLevel(lockedXpBefore).level;
    const levelAfter = computeLevel(xpAfter).level;

    // Best-effort side effect, deliberately after the transaction: a failed
    // notification must not roll back the XP it was announcing.
    await this.emitNotifications(
      userId,
      lockedLevelBefore,
      levelAfter,
      newBadgeKeys,
    );

    return {
      xpBefore: lockedXpBefore,
      xpAfter,
      levelBefore: lockedLevelBefore,
      levelAfter,
      newBadgeKeys,
    };
  }

  /**
   * Appends the "receipts" rows behind the frontend's XP ledger. One precise
   * row per newly-earned badge (name + its rarity bonus); the remaining
   * delta — signal-driven growth `recompute` can't attribute to a single
   * action, since XP here is computed lazily from live counts rather than
   * discrete events — becomes one generic row. Skipped entirely when XP
   * didn't grow (a no-op recompute, or a rare case where new-badge bonus
   * offset a signal that dropped in the interim).
   */
  private async writeLedgerEntries(
    manager: EntityManager,
    userId: string,
    xpBefore: number,
    xpAfter: number,
    newBadgeKeys: string[],
  ): Promise<void> {
    if (xpAfter <= xpBefore) return;

    let badgeBonusTotal = 0;
    const rows: Partial<RecognitionLedgerEntry>[] = newBadgeKeys.map(
      (badgeKey) => {
        const entry = BADGE_CATALOG.find((badge) => badge.key === badgeKey);
        const xp = entry ? (BADGE_BONUS_BY_RARITY[entry.rarity] ?? 0) : 0;
        badgeBonusTotal += xp;
        return {
          userId,
          description: `Badge earned: ${entry?.name ?? badgeKey}`,
          xp,
        };
      },
    );

    const activityDelta = xpAfter - xpBefore - badgeBonusTotal;
    if (activityDelta > 0) {
      rows.push({
        userId,
        description: 'Recognition recalculated from recent activity',
        xp: activityDelta,
      });
    }

    if (rows.length > 0) {
      await manager.getRepository(RecognitionLedgerEntry).insert(rows);
    }
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

  /**
   * Public, userId-only entry point for reading live signals without a full
   * recompute — used by `RecognitionService` to build the "what you did to
   * earn it" breakdown on every `GET /me/recognition`. See
   * `recomputeByUserId` above for why a synthetic `CurrentUserData` is safe
   * here.
   */
  async gatherSignalsForUser(userId: string): Promise<RecognitionSignals> {
    const user: CurrentUserData = {
      userId,
      email: '',
      status: UserStatus.Active,
      role: '',
    };
    return this.gatherSignals(user);
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
      volunteerSessions,
      directoryAnswers,
      resourcesApproved,
      eventsHeld,
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
      // Sessions a POSTER confirmed they attended. Never self-declared, and
      // `attended: false` (a recorded no-show) is excluded by the predicate
      // rather than by subtraction.
      //
      // `hoursContributed > 0` as well, because XP pays per SESSION (120 a
      // time) and never per hour. Without it, a confirmer who ticks "they
      // turned up" and leaves the hours box at 0 mints exactly as much
      // recognition as a full Saturday. The hours field is the only place any
      // work is described at all, so a session with none recorded is not yet
      // evidence of a session. This tightens the XP count ONLY: `myContribution`
      // and `volunteerHoursTotals` still count the confirmed session, because
      // "it happened, the hours were never written down" is a true thing to
      // show a member and a funder. The frontend copy agrees already:
      // "Confirmed HOURS count ... towards this member's recognition".
      this.volunteerSignups.count({
        where: {
          userId: user.userId,
          attended: true,
          completedAt: Not(IsNull()),
          hoursContributed: MoreThan(0),
        },
      }),
      // A public question on a directory listing that this member answered.
      // `isAnsweredByModerator` is not filtered on: a moderator answering a
      // question is doing the same work for the same reader.
      this.listingQuestions.count({
        where: { answeredById: user.userId, answeredAt: Not(IsNull()) },
      }),
      // APPROVED only, so submitting volume earns nothing.
      this.resourceSuggestions.count({
        where: {
          memberId: user.userId,
          status: ResourceSuggestionStatus.Approved,
        },
      }),
      // Gatherings that ACTUALLY HAPPENED and drew somebody, which is a
      // different question from the `hostedOpenEvents` on the eligibility DTO
      // below. See `PublicEligibilityService.countHeldGatherings`.
      this.eligibility.countHeldGatherings(user.userId),
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
      // `hostedOpenEvents` and `publishedPieces` are reused exactly as
      // `PublicEligibilityService` computes them (published + public
      // gatherings the member hosts or co-hosts; pieces of theirs behind a
      // published article or deck). Recomputing either here would be a second
      // definition of the same thing, free to drift. Both are capped at
      // `RESULT_CAP` (50) there, which is well above every XP_RULES cap on
      // this side, so the cap never truncates a score.
      //
      // `eventsHosted` is carried for readouts only: NOTHING in XP_RULES or
      // BADGE_REQUIREMENTS reads it any more, because a published, public
      // event costs one API call to create. Hosting pays on `eventsHeld`.
      eventsHosted: signalsDto.hostedOpenEvents.length,
      eventsHeld,
      piecesPublished: signalsDto.publishedPieces.length,
      volunteerSessions,
      directoryAnswers,
      resourcesApproved,
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

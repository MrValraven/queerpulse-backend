import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import { GovernanceLogAction } from '../communities/entities/community-governance-log.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { Community } from '../communities/entities/community.entity';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import {
  AdminCommunityDetailDTO,
  AdminCommunityListDTO,
  AdminCommunityModeratorDTO,
  AdminCommunityQueueItemDTO,
  CommunityAggregates,
  toAdminCommunityCard,
  toAdminCommunityDetail,
  toAdminModerator,
} from './admin-communities-response';
import {
  CommunityReportTotals,
  summariseReportsByCommunity,
} from './community-report-scope';
import { UpdateAdminCommunitySettingsDto } from './dto/update-admin-community-settings.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** The sparkline is always this many weekly buckets, oldest first. The admin
 *  UI divides by `length - 1` to space the points, so a short array would
 *  render as NaN — a quiet community gets eight zeros, never fewer. */
const SPARKLINE_WEEK_COUNT = 8;
const SPARKLINE_WINDOW_MS = SPARKLINE_WEEK_COUNT * WEEK_MS;

/** Roster roles that count as moderation staff. Plain members are excluded. */
const MODERATOR_ROLES = [RosterRole.Owner, RosterRole.Mod];

/** Payload cap for `listCommunities`: `this.communities.find(...)` had no
 *  `take` at all — an unbounded, full-platform scan on every admin dashboard
 *  load (AUDIT-2026-07-30.md §I "admin-communities full-platform scan").
 *  Well above current scale; matches the precedent at
 *  `admin-trust-network.service.ts`'s `MAX_NODES`. `listCommunities` surfaces
 *  a hit on this cap through `AdminCommunityListDTO.truncated` — mirroring
 *  `AdminTrustNetworkService`'s `TrustNetworkDTO.truncated` — in addition to
 *  the logger warning below. */
const MAX_LISTED_COMMUNITIES = 1000;

/** Payload cap for `loadReportScope`'s platform-wide report scan (AUDIT item
 *  #18). That query filtered only on `subjectType IN (...)` with no `take` — an
 *  unbounded read of every post/reply/community report on the platform, run on
 *  both admin endpoints (`getCommunity(slug)` pays it just to render one
 *  community's queue). Sized well above `MAX_LISTED_COMMUNITIES` because reports
 *  naturally outnumber communities and this set feeds the platform-wide
 *  aggregate report counts, not a single page; ordered `created_at DESC` so the
 *  cap keeps the newest reports. Like `MAX_LISTED_COMMUNITIES`, a hit on this
 *  cap is surfaced through the response body's `truncated` flag
 *  (`AdminCommunityListDTO.truncated` on `listCommunities`,
 *  `AdminCommunityDetailDTO.truncated` on `getCommunity`) in addition to the
 *  logger warning, and the new `IDX_reports_subject_type_created_at`
 *  (`1785903000000-AddReportsSubjectTypeCreatedAtIndex`) lets Postgres serve the
 *  `subject_type IN (...) ORDER BY created_at DESC LIMIT` as a bounded index
 *  scan rather than sorting the whole table first. */
const MAX_SCANNED_REPORTS = 2000;

/** Subject types whose reports can ever be attributed to a community.
 *  `member`, `venue` and `message` reports have no community and are dropped
 *  by `summariseReportsByCommunity` anyway — excluding them here keeps the
 *  fetch itself narrow. */
const COMMUNITY_SCOPED_SUBJECT_TYPES = [
  ReportSubjectType.Post,
  ReportSubjectType.Reply,
  ReportSubjectType.Community,
];

// `post`/`reply` subject ids end up bound against `post.id`/`reply.id`, both
// `@PrimaryGeneratedColumn('uuid')`. `Report.subjectId` is only ever validated
// as a 1-200 char string (`CreateReportDto`) — `ReportsService.create` never
// checks it resolves to a real row — so a member can file `POST /reports`
// with a non-UUID `subjectId` (e.g. `"x"`) and Postgres will reject any `IN
// (...)` that binds it against a uuid column with "invalid input syntax for
// type uuid", 500ing this read model on every dashboard load until the row is
// deleted by hand.
//
// Defined locally rather than imported from `ModerationService` (the only
// other place this pattern exists, at `src/moderation/moderation.service.ts`
// ~L62): that constant is a private implementation detail of a different
// feature module's service class, not exported, and not a shared utility —
// importing it would mean either reaching into another module's internals or
// widening moderation's public surface just to hand this module one regex.
// Same pattern, deliberately duplicated rather than coupled.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One row of the 56-day activity windows, shared by posts and replies. */
interface CommunityActivityRow {
  communityId: string;
  authorId: string;
  createdAt: Date;
}

/** One row of the content-id → community-id maps. */
interface CommunityContentIdRow {
  contentId: string;
  communityId: string;
}

/** The reports for a set of communities, plus the two lookup maps needed to
 *  attribute each one back to its community. Loaded once per request and
 *  shared by the aggregates and the scoped queue. */
interface CommunityReportScope {
  reports: Report[];
  communityIdBySubjectId: Map<string, string>;
  slugToCommunityId: Map<string, string>;
  /** True when `MAX_SCANNED_REPORTS` capped `reports` below the platform's
   *  actual community-scoped report count. */
  truncated: boolean;
}

function emptyCommunityAggregates(): CommunityAggregates {
  return {
    memberCount: 0,
    activeThisWeek: 0,
    postsThisWeek: 0,
    weeklyActivity: new Array<number>(SPARKLINE_WEEK_COUNT).fill(0),
    totalReportCount: 0,
    openReportCount: 0,
    overdueOpenReportCount: 0,
    severityWeightedOpenLoad: 0,
    // Only meaningful once seeded per-community from `community.createdAt` in
    // `aggregatesForMany`; defaults to 0 (treated as brand-new) for the
    // defensive `?? emptyCommunityAggregates()` fallbacks in `listCommunities`
    // and `getCommunity`, which should never actually be reached.
    communityAgeInDays: 0,
  };
}

/** Whole days elapsed between `community.createdAt` and `now`. Negative
 *  clock skew (a `createdAt` briefly in the future) floors at 0 rather than
 *  going negative, which would otherwise make a community look even younger
 *  than "brand new". */
function communityAgeInDaysFor(createdAt: Date, now: Date): number {
  return Math.max(
    0,
    Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS),
  );
}

/**
 * Read model behind the admin dashboard's communities tab.
 *
 * Every aggregate is computed with queries batched across the whole community
 * set — one query per metric, never one query per community — following the
 * grouped-count pattern in `CommunitiesService.statsForMany`.
 */
@Injectable()
export class AdminCommunitiesService {
  private readonly logger = new Logger(AdminCommunitiesService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(CommunityPost)
    private readonly communityPosts: Repository<CommunityPost>,
    @InjectRepository(CommunityPostReply)
    private readonly communityPostReplies: Repository<CommunityPostReply>,
    @InjectRepository(Report)
    private readonly reports: Repository<Report>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly governanceLog: CommunityGovernanceLogService,
  ) {}

  async listCommunities(): Promise<AdminCommunityListDTO> {
    // `take` bounds the scan to `MAX_LISTED_COMMUNITIES` — `IDX_communities_created_at`
    // (`1785700200000-AddCommunitiesCreatedAtIndex`) lets Postgres serve this
    // `ORDER BY created_at ASC LIMIT` as an `Index Scan ... Limit` that stops
    // after the cap, rather than sorting the whole table first.
    const allCommunities = await this.communities.find({
      order: { createdAt: 'ASC' },
      take: MAX_LISTED_COMMUNITIES,
    });
    const communitiesTruncated =
      allCommunities.length === MAX_LISTED_COMMUNITIES;
    if (communitiesTruncated) {
      this.logger.warn(
        `listCommunities truncated at ${MAX_LISTED_COMMUNITIES} communities — the admin dashboard is no longer showing every community on the platform.`,
      );
    }
    if (!allCommunities.length) return { items: [], truncated: false };

    const now = new Date();
    // The member and activity windows do not depend on the report scope, so
    // both loads are started together and joined inside `aggregatesForMany`
    // rather than run as two serial round trips.
    const reportScopePromise = this.loadReportScope(allCommunities);
    const aggregatesByCommunityId = await this.aggregatesForMany(
      allCommunities,
      now,
      reportScopePromise,
    );
    // Already resolved by the `Promise.all` inside `aggregatesForMany` above —
    // awaiting the same promise a second time just reads its cached result,
    // it does not re-run the query.
    const { truncated: reportsTruncated } = await reportScopePromise;

    const communityCards = allCommunities.map((community) =>
      toAdminCommunityCard(
        community,
        aggregatesByCommunityId.get(community.id) ?? emptyCommunityAggregates(),
      ),
    );

    // Flagged communities sort to the top as a group (worst health first
    // within it); everything else follows, also worst-first. Sorting on raw
    // healthScore alone would put a brand-new, unflagged community — whose
    // score is naturally low simply for lack of accumulated activity — above
    // established communities with a real, open incident. Being flagged and
    // being sorted-to-top are separate decisions; this keeps them in sync.
    communityCards.sort((firstCard, secondCard) => {
      if (firstCard.needsSupport !== secondCard.needsSupport) {
        return firstCard.needsSupport ? -1 : 1;
      }
      return firstCard.healthScore - secondCard.healthScore;
    });
    return {
      items: communityCards,
      truncated: communitiesTruncated || reportsTruncated,
    };
  }

  async getCommunity(slug: string): Promise<AdminCommunityDetailDTO> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    const now = new Date();
    const reportScopePromise = this.loadReportScope([community]);
    const [aggregatesByCommunityId, moderators, reportScope] =
      await Promise.all([
        this.aggregatesForMany([community], now, reportScopePromise),
        this.moderatorsFor(community.id),
        reportScopePromise,
      ]);

    return toAdminCommunityDetail(
      community,
      aggregatesByCommunityId.get(community.id) ?? emptyCommunityAggregates(),
      moderators,
      this.scopedQueueFor(community, reportScope, now),
      reportScope.truncated,
    );
  }

  /**
   * Update a community's safety-policy settings. Only the fields present on the
   * DTO are written, so a partial PATCH from a single toggle leaves the others
   * untouched. Returns the freshly rebuilt admin detail (via `getCommunity`) so
   * the caller renders from authoritative state — health/queue included —
   * rather than a hand-patched copy.
   */
  async updateSettings(
    slug: string,
    dto: UpdateAdminCommunitySettingsDto,
  ): Promise<AdminCommunityDetailDTO> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    if (dto.requiresSecondVouch !== undefined) {
      community.requiresSecondVouch = dto.requiresSecondVouch;
    }
    if (dto.autoFreezeOnReports !== undefined) {
      community.autoFreezeOnReports = dto.autoFreezeOnReports;
    }
    await this.communities.save(community);
    return this.getCommunity(slug);
  }

  /**
   * `POST /admin/communities/:slug/freeze` — freeze a community regardless of
   * who owns/moderates it (or whether it has an owner at all). This is the
   * admin override `CommunityAutoFreezeService`'s system-triggered freeze and
   * `CommunitiesService.unfreeze` (owner/mod-only lift) don't cover: there is
   * no member-facing "freeze on demand" endpoint, and unlike `unfreeze`, this
   * never checks roster role — the whole point is to work when the owner/mods
   * can't be trusted or reached.
   *
   * Idempotent: freezing an already-frozen community is a no-op 200 (the
   * first `frozen_at` timestamp stands) — same conditional-UPDATE race-safety
   * pattern as `CommunityAutoFreezeService.maybeFreeze` (`WHERE frozen_at IS
   * NULL`), so two concurrent freezes can't double-write, and a governance-log
   * entry is only written when this call is the one that actually changed the
   * state.
   */
  async freeze(
    slug: string,
    actorUserId: string,
  ): Promise<AdminCommunityDetailDTO> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    const result = await this.communities
      .createQueryBuilder()
      .update(Community)
      .set({ frozenAt: () => 'now()' })
      .where('id = :id AND frozen_at IS NULL', { id: community.id })
      .execute();

    if (result.affected) {
      await this.governanceLog.log({
        communityId: community.id,
        actorUserId,
        action: GovernanceLogAction.Frozen,
        metadata: { adminOverride: true },
      });
    }

    return this.getCommunity(slug);
  }

  /**
   * `POST /admin/communities/:slug/unfreeze` — lift a freeze regardless of
   * who owns/moderates the community. `CommunitiesService.unfreeze` already
   * covers the normal path (an owner/mod lifting it themselves); this is the
   * override for when they can't or won't — no roster role is checked here.
   *
   * Idempotent, same conditional-UPDATE pattern as `freeze` in reverse
   * (`WHERE frozen_at IS NOT NULL`): unfreezing a community that isn't frozen
   * is a no-op 200, and the governance log only gets an entry when this call
   * actually lifted something.
   */
  async unfreeze(
    slug: string,
    actorUserId: string,
  ): Promise<AdminCommunityDetailDTO> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    const result = await this.communities
      .createQueryBuilder()
      .update(Community)
      .set({ frozenAt: null })
      .where('id = :id AND frozen_at IS NOT NULL', { id: community.id })
      .execute();

    if (result.affected) {
      await this.governanceLog.log({
        communityId: community.id,
        actorUserId,
        action: GovernanceLogAction.Unfrozen,
        metadata: { adminOverride: true },
      });
    }

    return this.getCommunity(slug);
  }

  /**
   * `POST /admin/communities/:slug/archive` — archive a community regardless
   * of its ownership state. `CommunitiesService.archive` sets the very same
   * `archivedAt` column but is OWNER-ONLY (`assertOwner`), which an ownerless
   * community (`Community.ownerId === null`, pending `needsOwnerReviewAt`
   * review) can never satisfy — there would be no lever left to take such a
   * community down at all. Reimplemented here directly against the
   * repository rather than calling that method, precisely to skip its
   * authorization check.
   *
   * Idempotent, same conditional-UPDATE shape as `freeze`/`unfreeze`: an
   * already-archived community is a no-op 200 (the first `archivedAt`
   * stands), and the governance log only gets an entry when this call is the
   * one that actually archived it. Reversible via `unarchive` below
   * (COM-18) — archiving a community is no longer a one-way door.
   */
  async archive(
    slug: string,
    actorUserId: string,
  ): Promise<AdminCommunityDetailDTO> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    const result = await this.communities
      .createQueryBuilder()
      .update(Community)
      .set({ archivedAt: () => 'now()' })
      .where('id = :id AND archived_at IS NULL', { id: community.id })
      .execute();

    if (result.affected) {
      await this.governanceLog.log({
        communityId: community.id,
        actorUserId,
        action: GovernanceLogAction.Archived,
        metadata: { adminOverride: true },
      });
    }

    return this.getCommunity(slug);
  }

  /**
   * `POST /admin/communities/:slug/unarchive` — reverse an archive regardless
   * of the community's ownership state (COM-18: archiving used to be a
   * one-way door even for admins). Same conditional-UPDATE shape as `archive`
   * in reverse (`WHERE archived_at IS NOT NULL`): unarchiving a community that
   * isn't archived is a no-op 200, and the governance log only gets an entry
   * when this call actually lifted the archive.
   */
  async unarchive(
    slug: string,
    actorUserId: string,
  ): Promise<AdminCommunityDetailDTO> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    const result = await this.communities
      .createQueryBuilder()
      .update(Community)
      .set({ archivedAt: null })
      .where('id = :id AND archived_at IS NOT NULL', { id: community.id })
      .execute();

    if (result.affected) {
      await this.governanceLog.log({
        communityId: community.id,
        actorUserId,
        action: GovernanceLogAction.Unarchived,
        metadata: { adminOverride: true },
      });
    }

    return this.getCommunity(slug);
  }

  /**
   * `POST /admin/communities/:slug/reassign-owner` — hand ownership to any
   * roster member, admin override of `CommunitiesService.transferOwnership`.
   * That method is CURRENT-OWNER-ONLY (`assertOwner`) and therefore can never
   * run on the exact case this endpoint exists for: a community with NO
   * current owner (`ownerId === null`) — there is no owner to be the actor.
   * Reimplemented here directly against the repositories, in a transaction
   * mirroring `transferOwnership`'s three-write shape (new owner's roster row
   * -> `owner`, `Community.ownerId` -> the target, previous owner's roster
   * row -> `mod` if one existed), plus clearing `needsOwnerReviewAt` — the
   * flag this endpoint is the intended way to resolve.
   *
   *  - Target must already be on this community's roster: 404 otherwise,
   *    matching `transferOwnership`'s "Member not found" for an unknown
   *    target (a reassignment is a promotion of an existing member, never a
   *    way to force someone onto the roster).
   *  - The house account can never become an owner — mirrors
   *    `transferOwnership`'s same guardrail.
   *  - Idempotent: reassigning to the member who already owns the community
   *    is a no-op that skips both the write and the governance-log entry.
   */
  async reassignOwner(
    slug: string,
    actorUserId: string,
    memberSlug: string,
  ): Promise<AdminCommunityDetailDTO> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    const targetUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!targetUserId) {
      throw new NotFoundException('Member not found');
    }
    const targetMembership = await this.communityMembers.findOne({
      where: { communityId: community.id, userId: targetUserId },
    });
    if (!targetMembership) {
      throw new NotFoundException('Member not found');
    }

    const previousOwnerId = community.ownerId;
    if (previousOwnerId === targetUserId) {
      // Already the owner — nothing to change, nothing to log.
      return this.getCommunity(slug);
    }

    const targetUser = await this.users.findOne({
      where: { id: targetUserId },
      select: { id: true, isSystem: true },
    });
    if (targetUser?.isSystem) {
      throw new BadRequestException(
        'Ownership cannot be transferred to the house account',
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const communitiesRepo = manager.getRepository(Community);
      const membersRepo = manager.getRepository(CommunityMember);

      await communitiesRepo.update(community.id, {
        ownerId: targetUserId,
        needsOwnerReviewAt: null,
      });

      targetMembership.role = RosterRole.Owner;
      await membersRepo.save(targetMembership);

      // Outgoing owner (if any) stays on the roster, demoted to mod — guarded
      // on the row still reading `owner` so this can't double-demote
      // something already moved by a concurrent call. Mirrors
      // `CommunitiesService.transferOwnership`.
      if (previousOwnerId) {
        const previousOwnerMembership = await membersRepo.findOne({
          where: { communityId: community.id, userId: previousOwnerId },
        });
        if (
          previousOwnerMembership &&
          previousOwnerMembership.role === RosterRole.Owner
        ) {
          previousOwnerMembership.role = RosterRole.Mod;
          await membersRepo.save(previousOwnerMembership);
        }
      }
    });

    await this.governanceLog.log({
      communityId: community.id,
      actorUserId,
      action: GovernanceLogAction.OwnershipTransferred,
      targetUserId,
      metadata: { adminOverride: true, previousOwnerId },
    });

    return this.getCommunity(slug);
  }

  /**
   * `DELETE /admin/communities/:slug/members/:memberSlug` — remove any
   * roster member outright, admin override of the fact that
   * `AdminCommunityModeratorsService` can only ever move someone between
   * `member` and `mod`, never off the roster entirely. Lives here rather than
   * on `AdminCommunityModeratorsController` because that controller's
   * `@Controller('admin/communities/:slug/moderators')` prefix would force
   * the route under `.../moderators/members/:memberSlug`; this controller's
   * bare `admin/communities` prefix is what makes the intended
   * `:slug/members/:memberSlug` path possible, and it's already admin-only
   * (no `@Roles` override needed, unlike the moderators controller, whose
   * class-level `@Roles` also admits `Moderator`).
   *
   * Deliberately not a call into `CommunitiesService.removeMember`: that
   * method's authorization (self-removal, or `assertOwnerOrMod`) is the wrong
   * shape for an admin actor, who is typically on neither the roster nor the
   * mod team of the community they're moderating from the platform side.
   *
   *  - 404 if `memberSlug` is not on this community's roster (mirrors
   *    `removeMember`'s "Member not found").
   *  - 400 if the target is the owner — same "the owner cannot be removed"
   *    guardrail `removeMember` enforces, worded identically. An admin who
   *    needs the owner gone reassigns ownership first (`reassignOwner`), then
   *    removes the now-demoted-to-mod former owner if that's still wanted.
   */
  async removeMember(
    slug: string,
    actorUserId: string,
    memberSlug: string,
  ): Promise<void> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    const targetUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!targetUserId) {
      throw new NotFoundException('Member not found');
    }
    const targetMembership = await this.communityMembers.findOne({
      where: { communityId: community.id, userId: targetUserId },
    });
    if (!targetMembership) {
      throw new NotFoundException('Member not found');
    }

    if (targetMembership.role === RosterRole.Owner) {
      throw new BadRequestException('The owner cannot be removed');
    }

    await this.communityMembers.delete({ id: targetMembership.id });

    await this.governanceLog.log({
      communityId: community.id,
      actorUserId,
      action: GovernanceLogAction.MemberRemoved,
      targetUserId,
      metadata: { adminOverride: true },
    });
  }

  /**
   * Build the full aggregate set for every given community in a fixed number
   * of queries: member counts, the 56-day post and reply activity windows,
   * the content-id maps that let reports be attributed, and the reports
   * themselves. Nothing here scales with the number of communities.
   *
   * `reportScopePromise` is taken unresolved on purpose: only the report
   * summary at the end needs it, so the caller can start it in parallel with
   * the member and activity queries issued here.
   */
  private async aggregatesForMany(
    communitiesInScope: Community[],
    now: Date,
    reportScopePromise: Promise<CommunityReportScope>,
  ): Promise<Map<string, CommunityAggregates>> {
    const aggregatesByCommunityId = new Map<string, CommunityAggregates>(
      communitiesInScope.map((community) => [
        community.id,
        {
          ...emptyCommunityAggregates(),
          communityAgeInDays: communityAgeInDaysFor(community.createdAt, now),
        },
      ]),
    );
    const communityIdsInScope = communitiesInScope.map(
      (community) => community.id,
    );
    // MINOR 2: no empty-`communityIdsInScope` guard here. `listCommunities`
    // already returns at its own `if (!allCommunities.length) return [];`
    // before this method is ever called, and `getCommunity` only ever calls
    // it with a one-element array — so this method is never invoked with an
    // empty scope, and `reportScopePromise` is always observed via the
    // `Promise.all` immediately below regardless.
    const [reportScope, memberCountRows, postActivityRows, replyActivityRows] =
      await Promise.all([
        reportScopePromise,
        this.loadMemberCounts(communityIdsInScope),
        this.loadPostActivity(communityIdsInScope, now),
        this.loadReplyActivity(communityIdsInScope, now),
      ]);

    for (const memberCountRow of memberCountRows) {
      const aggregates = aggregatesByCommunityId.get(
        memberCountRow.communityId,
      );
      if (aggregates) aggregates.memberCount = Number(memberCountRow.count);
    }

    const activeAuthorIdsByCommunityId = new Map<string, Set<string>>(
      communityIdsInScope.map((communityId) => [
        communityId,
        new Set<string>(),
      ]),
    );
    const oneWeekAgoMs = now.getTime() - WEEK_MS;

    for (const postActivityRow of postActivityRows) {
      const aggregates = aggregatesByCommunityId.get(
        postActivityRow.communityId,
      );
      if (!aggregates) continue;
      this.addToSparkline(aggregates.weeklyActivity, postActivityRow, now);
      if (postActivityRow.createdAt.getTime() >= oneWeekAgoMs) {
        aggregates.postsThisWeek += 1;
        activeAuthorIdsByCommunityId
          .get(postActivityRow.communityId)
          ?.add(postActivityRow.authorId);
      }
    }

    for (const replyActivityRow of replyActivityRows) {
      const aggregates = aggregatesByCommunityId.get(
        replyActivityRow.communityId,
      );
      if (!aggregates) continue;
      this.addToSparkline(aggregates.weeklyActivity, replyActivityRow, now);
      if (replyActivityRow.createdAt.getTime() >= oneWeekAgoMs) {
        activeAuthorIdsByCommunityId
          .get(replyActivityRow.communityId)
          ?.add(replyActivityRow.authorId);
      }
    }

    for (const [communityId, activeAuthorIds] of activeAuthorIdsByCommunityId) {
      const aggregates = aggregatesByCommunityId.get(communityId);
      if (aggregates) aggregates.activeThisWeek = activeAuthorIds.size;
    }

    // The buckets are filled newest-week-first above; the DTO contract is
    // oldest first.
    for (const aggregates of aggregatesByCommunityId.values()) {
      aggregates.weeklyActivity.reverse();
    }

    const reportTotalsByCommunityId = summariseReportsByCommunity(
      reportScope.reports,
      reportScope.communityIdBySubjectId,
      reportScope.slugToCommunityId,
      now,
    );
    for (const [communityId, reportTotals] of reportTotalsByCommunityId) {
      const aggregates = aggregatesByCommunityId.get(communityId);
      if (aggregates) this.applyReportTotals(aggregates, reportTotals);
    }

    return aggregatesByCommunityId;
  }

  /** Newest week is index 0 while filling; the caller reverses at the end. */
  private addToSparkline(
    weeklyActivity: number[],
    activityRow: CommunityActivityRow,
    now: Date,
  ): void {
    const weekIndex = Math.floor(
      (now.getTime() - activityRow.createdAt.getTime()) / WEEK_MS,
    );
    if (weekIndex < 0 || weekIndex >= SPARKLINE_WEEK_COUNT) return;
    weeklyActivity[weekIndex] = (weeklyActivity[weekIndex] ?? 0) + 1;
  }

  private applyReportTotals(
    aggregates: CommunityAggregates,
    reportTotals: CommunityReportTotals,
  ): void {
    aggregates.totalReportCount = reportTotals.totalReportCount;
    aggregates.openReportCount = reportTotals.openReportCount;
    aggregates.overdueOpenReportCount = reportTotals.overdueOpenReportCount;
    aggregates.severityWeightedOpenLoad = reportTotals.severityWeightedOpenLoad;
  }

  private loadMemberCounts(
    communityIdsInScope: string[],
  ): Promise<Array<{ communityId: string; count: string }>> {
    return this.communityMembers
      .createQueryBuilder('member')
      .select('member.community_id', 'communityId')
      .addSelect('COUNT(*)', 'count')
      .where('member.community_id IN (:...communityIdsInScope)', {
        communityIdsInScope,
      })
      .groupBy('member.community_id')
      .getRawMany<{ communityId: string; count: string }>();
  }

  /**
   * Posts created inside the sparkline window. `community_id IS NOT NULL`
   * guards against flat/global posts, which belong to no community and would
   * otherwise form a phantom NULL bucket.
   */
  private loadPostActivity(
    communityIdsInScope: string[],
    now: Date,
  ): Promise<CommunityActivityRow[]> {
    const sparklineWindowStart = new Date(now.getTime() - SPARKLINE_WINDOW_MS);
    return this.communityPosts
      .createQueryBuilder('post')
      .select('post.community_id', 'communityId')
      .addSelect('post.author_id', 'authorId')
      .addSelect('post.created_at', 'createdAt')
      .where('post.community_id IN (:...communityIdsInScope)', {
        communityIdsInScope,
      })
      .andWhere('post.community_id IS NOT NULL')
      .andWhere('post.created_at >= :sparklineWindowStart', {
        sparklineWindowStart,
      })
      .getRawMany<CommunityActivityRow>();
  }

  /** Replies carry no `communityId` of their own — they inherit it from the
   *  post they hang off, so the community filter joins through posts. */
  private loadReplyActivity(
    communityIdsInScope: string[],
    now: Date,
  ): Promise<CommunityActivityRow[]> {
    const sparklineWindowStart = new Date(now.getTime() - SPARKLINE_WINDOW_MS);
    return this.communityPostReplies
      .createQueryBuilder('reply')
      .innerJoin(CommunityPost, 'post', 'post.id = reply.post_id')
      .select('post.community_id', 'communityId')
      .addSelect('reply.author_id', 'authorId')
      .addSelect('reply.created_at', 'createdAt')
      .where('post.community_id IN (:...communityIdsInScope)', {
        communityIdsInScope,
      })
      .andWhere('post.community_id IS NOT NULL')
      .andWhere('reply.created_at >= :sparklineWindowStart', {
        sparklineWindowStart,
      })
      .getRawMany<CommunityActivityRow>();
  }

  /**
   * Everything needed to attribute reports to communities:
   *
   * - `communityIdBySubjectId` is keyed by BOTH post ids AND reply ids, as
   *   `summariseReportsByCommunity` requires — a map built from only one of
   *   the two content tables silently drops the other subject type's reports.
   * - `slugToCommunityId` resolves `community`-subject reports, whose
   *   `subjectId` is a slug rather than a content id.
   *
   * The join runs reports-first on purpose. Building the id map from the
   * content tables and handing the union to `subjectId: In(...)` made the
   * parameter list grow one bind parameter per post and per reply on the
   * platform; past 65535 of them Postgres rejects the statement outright
   * (`bind message has 65535 parameter formats but N parameters`), and it
   * dragged both content tables into the Node heap on every dashboard load.
   * Reports are the small set, so they are fetched first and only the subject
   * ids they actually reference are resolved — the parameter list is now
   * bounded by the number of community-scoped reports, not by content volume.
   */
  private async loadReportScope(
    communitiesInScope: Community[],
  ): Promise<CommunityReportScope> {
    const communityIdsInScope = communitiesInScope.map(
      (community) => community.id,
    );
    const slugToCommunityId = new Map<string, string>(
      communitiesInScope.map((community) => [community.slug, community.id]),
    );
    const communityIdBySubjectId = new Map<string, string>();

    // Never joined against `reporterId`: it is nullable by design (account
    // erasure NULLs it while keeping the report), so an inner join would
    // silently drop the reports of erased accounts.
    //
    // Projected to only the columns `scopedQueueFor` and
    // `summariseReportsByCommunity` actually read (MINOR 1): every post/reply/
    // community report on the platform is fetched on both admin endpoints —
    // `getCommunity(slug)` in particular pays this just to render one
    // community's queue — so pulling the full row (including `text detail`
    // and `jsonb evidence`) for every one of them is unnecessary weight.
    const reports = await this.reports
      .createQueryBuilder('report')
      .select([
        'report.id',
        'report.subjectType',
        'report.subjectId',
        'report.severity',
        'report.reasonCode',
        'report.detail',
        'report.status',
        'report.slaDueAt',
        'report.createdAt',
      ])
      .where('report.subjectType IN (:...subjectTypes)', {
        subjectTypes: COMMUNITY_SCOPED_SUBJECT_TYPES,
      })
      .orderBy('report.createdAt', 'DESC')
      .take(MAX_SCANNED_REPORTS)
      .getMany();
    const truncated = reports.length === MAX_SCANNED_REPORTS;
    if (truncated) {
      this.logger.warn(
        `loadReportScope truncated at ${MAX_SCANNED_REPORTS} reports — the admin community dashboard's report aggregates and queues are no longer counting every community-scoped report on the platform.`,
      );
    }

    // `community` reports carry a slug, resolved through `slugToCommunityId`;
    // only post and reply subjects need a content-id lookup. Non-UUID subject
    // ids are dropped before they can reach the `post.id`/`reply.id IN (...)`
    // clauses below (CRITICAL) — those are `uuid` columns, and a member can
    // file a report with an arbitrary string `subjectId` (see `UUID_RE`'s
    // comment above). Dropping them here is behaviour-preserving: a non-UUID
    // string could never have matched a `post.id` or `reply.id` anyway.
    const reportedContentIds = [
      ...new Set(
        reports
          .filter(
            (report) => report.subjectType !== ReportSubjectType.Community,
          )
          .map((report) => report.subjectId),
      ),
    ].filter((subjectId) => UUID_RE.test(subjectId));

    // `IN ()` is not valid SQL — with nothing to resolve, skip both queries.
    if (!reportedContentIds.length || !communityIdsInScope.length) {
      return { reports, communityIdBySubjectId, slugToCommunityId, truncated };
    }

    const [postIdRows, replyIdRows] = await Promise.all([
      this.loadPostCommunityIds(communityIdsInScope, reportedContentIds),
      this.loadReplyCommunityIds(communityIdsInScope, reportedContentIds),
    ]);

    for (const contentIdRow of [...postIdRows, ...replyIdRows]) {
      communityIdBySubjectId.set(
        contentIdRow.contentId,
        contentIdRow.communityId,
      );
    }

    return { reports, communityIdBySubjectId, slugToCommunityId, truncated };
  }

  /** Resolves reported post ids to their community. Subject ids that name a
   *  reply, a post outside the scope, or nothing at all simply do not match. */
  private loadPostCommunityIds(
    communityIdsInScope: string[],
    reportedContentIds: string[],
  ): Promise<CommunityContentIdRow[]> {
    return this.communityPosts
      .createQueryBuilder('post')
      .select('post.id', 'contentId')
      .addSelect('post.community_id', 'communityId')
      .where('post.id IN (:...reportedContentIds)', { reportedContentIds })
      .andWhere('post.community_id IN (:...communityIdsInScope)', {
        communityIdsInScope,
      })
      .andWhere('post.community_id IS NOT NULL')
      .getRawMany<CommunityContentIdRow>();
  }

  /** Replies carry no community of their own, so a reported reply resolves to
   *  its PARENT POST's community via the join. */
  private loadReplyCommunityIds(
    communityIdsInScope: string[],
    reportedContentIds: string[],
  ): Promise<CommunityContentIdRow[]> {
    return this.communityPostReplies
      .createQueryBuilder('reply')
      .innerJoin(CommunityPost, 'post', 'post.id = reply.post_id')
      .select('reply.id', 'contentId')
      .addSelect('post.community_id', 'communityId')
      .where('reply.id IN (:...reportedContentIds)', { reportedContentIds })
      .andWhere('post.community_id IN (:...communityIdsInScope)', {
        communityIdsInScope,
      })
      .andWhere('post.community_id IS NOT NULL')
      .getRawMany<CommunityContentIdRow>();
  }

  private async moderatorsFor(
    communityId: string,
  ): Promise<AdminCommunityModeratorDTO[]> {
    const moderatorMembers = await this.communityMembers.find({
      where: { communityId, role: In(MODERATOR_ROLES) },
      order: { joinedAt: 'ASC' },
    });
    if (!moderatorMembers.length) return [];

    const memberLookup = new MemberLookup(this.profiles);
    const memberRefsByUserId = await memberLookup.byUserIds(
      moderatorMembers.map((moderatorMember) => moderatorMember.userId),
    );

    const moderators: AdminCommunityModeratorDTO[] = [];
    for (const moderatorMember of moderatorMembers) {
      const memberRef = memberRefsByUserId.get(moderatorMember.userId);
      if (!memberRef) {
        // A moderator with no profile row is exactly the anomaly this admin
        // surface exists to catch — dropping it silently would render the
        // community as unmoderated with no explanation.
        this.logger.warn(
          `Community ${communityId} has a ${moderatorMember.role} (user ${moderatorMember.userId}) with no profile row; omitting from the moderator list.`,
        );
        continue;
      }
      moderators.push(
        toAdminModerator(
          moderatorMember.userId,
          memberRef,
          moderatorMember.role === RosterRole.Owner ? 'owner' : 'mod',
          moderatorMember.joinedAt,
        ),
      );
    }
    return moderators;
  }

  /** That community's open reports, newest first. */
  private scopedQueueFor(
    community: Community,
    reportScope: CommunityReportScope,
    now: Date,
  ): AdminCommunityQueueItemDTO[] {
    return reportScope.reports
      .filter((report) => {
        if (report.status !== ReportStatus.Open) return false;
        const communityId =
          report.subjectType === ReportSubjectType.Community
            ? reportScope.slugToCommunityId.get(report.subjectId)
            : reportScope.communityIdBySubjectId.get(report.subjectId);
        return communityId === community.id;
      })
      .sort(
        (firstReport, secondReport) =>
          secondReport.createdAt.getTime() - firstReport.createdAt.getTime(),
      )
      .map((report) => ({
        id: report.id,
        severity: report.severity,
        reasonCode: report.reasonCode,
        detail: report.detail,
        status: report.status,
        overdue: report.slaDueAt.getTime() < now.getTime(),
        createdAt: report.createdAt.toISOString(),
      }));
  }
}

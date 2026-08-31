import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual, Not, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  communityBanHoldExpiryFrom,
  COMMUNITY_BAN_RATIFICATION_WINDOW_HOURS,
  COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS,
} from './community-ban-ratification-window';
import {
  CommunityBanRatificationDTO,
  CommunityBanRatificationListDTO,
  toCommunityBanRatificationDTO,
} from './community-ban-ratifications-response';
import {
  COMMUNITY_BAN_AUDIT_ACTION,
  CommunityGovernanceLogService,
} from './community-governance-log.service';
import {
  COMMUNITY_STAFF_ROLES,
  resolveStaffCommunity,
} from './community-staff-access';
import { RatifyCommunityBanDto } from './dto/ratify-community-ban.dto';
import {
  COMMUNITY_BAN_INTERIM_ACTION,
  CommunityBanRatification,
  CommunityBanRatificationStatus,
} from './entities/community-ban-ratification.entity';
import { CommunityBan } from './entities/community-ban.entity';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { Community } from './entities/community.entity';

/** What `proposePermanentBar` needs to open a hold. */
export interface ProposePermanentBarInput {
  community: Community;
  /** The bar already written and already in force, at the 30-day fallback. */
  ban: CommunityBan;
  /** The owner, co-owner or moderator who asked for the permanence. */
  proposerUserId: string;
  /** Their own words, as written on the removal. */
  reason: string | null;
  now?: Date;
}

/**
 * The second signature on a PERMANENT community bar (PRD-25).
 *
 * MIRRORS `BanRatificationService` (`src/moderation/ban-ratification.service.ts`),
 * the platform-level control TS-12 built for exactly the same problem one
 * level up. Same status vocabulary, same partial-unique pending row, same
 * conditional-`UPDATE` claim on the transition, same lazy expiry, same refusal
 * to let the proposer sign their own request. A reader who knows one of these
 * two files knows the other.
 *
 * THE FOUR DECISIONS THIS FLOW MAKES, and why:
 *
 * 1. WHAT HAPPENS TO THE MEMBER WHILE THE HOLD STANDS: they are OFF THE ROSTER
 *    and BARRED, for {@link COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS} days, from
 *    the first second. Nobody stays in a room they were just thrown out of
 *    while paperwork clears. Only the PERMANENCE waits. That is the difference
 *    from the platform hold, where the interim consequence is a suspension
 *    nobody has confirmed; here the removal itself was always one moderator's
 *    to make, and it is only the "forever" that needs a second person.
 *
 * 2. WHAT EXPIRY MEANS: the bar SETTLES AT 30 DAYS. It does not lapse to
 *    nothing and it does not escalate. Lapsing to nothing would put the person
 *    back through the door on a technicality of staffing, over a removal their
 *    community's own moderator was entitled to make. Escalating would let a
 *    permanent bar nobody was willing to sign become permanent through
 *    inaction, which is the exact failure the second signature exists to
 *    prevent. Thirty days is what one signature is worth.
 *
 * 3. WHO MAY SIGN: any owner, co-owner or moderator of that community EXCEPT
 *    the one who asked. No carve-out for the owner, and that is deliberate
 *    rather than an oversight. A solo-owner community is precisely the case
 *    this control is worried about, so exempting the owner would put the hole
 *    exactly where the risk is. Such a community gets no hold at all and the
 *    bar stands at 30 days, which `proposePermanentBar` reports by returning
 *    null so the caller can say so plainly.
 *
 * 4. EXPIRY IS LAZY, never a cron. This module does run scheduled work
 *    (`CommunityActivityCounterService`, `CommunityOwnerInactivityService`),
 *    so a cron was available and was still the wrong tool: nothing in the
 *    product depends on a hold being marked expired at the exact second it
 *    lapses, because the sanction the member is actually serving is already
 *    correct without any write at all. The `community_bans` row carries a
 *    30-day `expires_at` from the moment of the removal, and every join path
 *    filters on that clock. `expireDueHolds()` therefore only tidies the
 *    record and writes the governance entry, and it runs at the top of the
 *    queue read, the ban list read and every decision, matching the platform
 *    hold and `CommunitiesService.assertNotBanned`.
 */
@Injectable()
export class CommunityBanRatificationService {
  private readonly logger = new Logger(CommunityBanRatificationService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityBan)
    private readonly bans: Repository<CommunityBan>,
    @InjectRepository(CommunityBanRatification)
    private readonly ratifications: Repository<CommunityBanRatification>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly governanceLog: CommunityGovernanceLogService,
    // The barred member is told when the bar becomes permanent. A sanction
    // whose terms move without the person serving it being told is the
    // unexplained enforcement the notification pipeline exists to prevent.
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Is there anybody in this community, other than the proposer, who could
   * sign a permanent bar?
   *
   * Counts owner, co-owner and moderator roster rows, which is the same tier
   * `resolveStaffCommunity` admits, so this question and the authorisation on
   * the decide route can never drift apart. The member being removed is
   * already off the roster by the time this runs, so they can never count
   * towards their own bar.
   */
  async hasSecondEligibleSignatory(
    communityId: string,
    proposerUserId: string,
  ): Promise<boolean> {
    const eligibleSignatoryCount = await this.members.count({
      where: {
        communityId,
        role: In(COMMUNITY_STAFF_ROLES as RosterRole[]),
        userId: Not(proposerUserId),
      },
    });
    return eligibleSignatoryCount > 0;
  }

  /**
   * Open the hold a permanent bar now waits in, or return null when this
   * community has nobody else who could sign it.
   *
   * Called AFTER the bar is written and in force, by
   * `CommunitiesService.barReturn` (the removal path) and
   * `CommunityBansService.updateBan` (the "make this permanent" path). Both
   * have already applied the 30-day term, so a null return needs no
   * compensating write: the correct sanction is already on file, and the
   * caller's job is only to say so.
   *
   * Idempotent against the partial unique index: a member already pending in
   * this community keeps the hold on file rather than opening a second race on
   * the same person, exactly as the platform hold joins rather than forks.
   */
  async proposePermanentBar(
    input: ProposePermanentBarInput,
  ): Promise<CommunityBanRatification | null> {
    const now = input.now ?? new Date();
    const communityId = input.community.id;
    const targetUserId = input.ban.userId;

    if (
      !(await this.hasSecondEligibleSignatory(
        communityId,
        input.proposerUserId,
      ))
    ) {
      return null;
    }

    const existingHold = await this.ratifications.findOne({
      where: {
        communityId,
        targetUserId,
        status: CommunityBanRatificationStatus.Pending,
      },
    });
    if (existingHold) {
      // Already waiting on somebody. Returning the hold on file rather than a
      // fresh one means the caller reports the deadline the second signatory
      // is actually working to.
      return existingHold;
    }

    // The display-name snapshot, taken now, is what lets the queue still name
    // the person after they erase their account. Read straight off `profiles`
    // rather than through `MemberLookup`, which restricts to ACTIVE users: a
    // barred member may well be suspended, and the record still has to say who
    // they were.
    const profile = await this.profiles.findOne({
      where: { userId: targetUserId },
      select: { firstName: true, lastName: true },
    });
    const targetName = profile
      ? `${profile.firstName} ${profile.lastName}`.trim() || null
      : null;

    const hold = await this.ratifications.save(
      this.ratifications.create({
        communityId,
        targetUserId,
        targetName,
        requestedBy: input.proposerUserId,
        note: input.reason,
        ruleIndex: input.ban.ruleIndex,
        ruleVersion: input.ban.ruleVersion,
        ruleText: input.ban.ruleText,
        interimAction: COMMUNITY_BAN_INTERIM_ACTION,
        expiresAt: communityBanHoldExpiryFrom(now),
        status: CommunityBanRatificationStatus.Pending,
      }),
    );

    await this.logGovernanceEntry(
      communityId,
      input.proposerUserId,
      GovernanceLogAction.MemberBanProposed,
      targetUserId,
      {
        ...(input.reason ? { reason: input.reason } : {}),
        banExpiresAt: input.ban.expiresAt?.toISOString() ?? null,
        ratificationExpiresAt: hold.expiresAt.toISOString(),
      },
    );

    return hold;
  }

  /**
   * `GET /communities/:slug/ban-ratifications`: the permanent bars this
   * community's staff have asked for, and what happened to them.
   *
   * Pending by default and ordered soonest-to-lapse, because the hold about to
   * expire is the one somebody has to look at today. Every other status is a
   * history view, where newest first is the useful order. Same split the
   * platform queue makes.
   */
  async listBySlug(
    slug: string,
    userId: string,
    status: CommunityBanRatificationStatus = CommunityBanRatificationStatus.Pending,
  ): Promise<CommunityBanRatificationListDTO> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      userId,
    );
    await this.expireDueHolds(community.id);

    const rows = await this.ratifications.find({
      where: { communityId: community.id, status },
      order:
        status === CommunityBanRatificationStatus.Pending
          ? { expiresAt: 'ASC' }
          : { createdAt: 'DESC' },
      take: 100,
    });

    return {
      ratifications: await this.toRows(rows, community, userId),
      total: rows.length,
      windowHours: COMMUNITY_BAN_RATIFICATION_WINDOW_HOURS,
      fallbackDays: COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS,
    };
  }

  /**
   * `PATCH /communities/:slug/ban-ratifications/:id`: the second signature,
   * or the refusal.
   *
   * On RATIFY the bar becomes permanent: `community_bans.expires_at` goes to
   * NULL, a `community_ban_applied` row is written in the RATIFIER's name with
   * no duration, and the member is told. That audit row is what keeps the
   * permanent bar appealable in its own right, the same way
   * `BanRatificationService.decide` writes the canonical `ban` code at the
   * moment the platform ban takes effect.
   *
   * On DECLINE nothing about the member's standing changes: they were barred
   * for 30 days at removal and they still are. The refusal is recorded because
   * one moderator refusing another's permanent bar is worth as much in the
   * trail as the bar would have been.
   */
  async decide(
    slug: string,
    actorUserId: string,
    ratificationId: string,
    dto: RatifyCommunityBanDto,
  ): Promise<CommunityBanRatificationDTO> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      actorUserId,
    );
    await this.expireDueHolds(community.id);

    const hold = await this.ratifications.findOne({
      where: { id: ratificationId, communityId: community.id },
    });
    if (!hold) {
      throw new NotFoundException('That bar is not waiting on anyone.');
    }
    if (hold.status !== CommunityBanRatificationStatus.Pending) {
      throw new ConflictException(
        'That bar has already been decided, or it has lapsed to 30 days.',
      );
    }
    // The whole point of the control. `requestedBy` is NULL only when the
    // proposer has since erased their account, and an unknown proposer can
    // never equal a live `actorUserId`, so this fails to "not you".
    if (hold.requestedBy && hold.requestedBy === actorUserId) {
      throw new ForbiddenException(
        'You asked for this bar, so you cannot be the one who confirms it. It needs a second pair of eyes.',
      );
    }

    const ban = await this.bans.findOne({
      where: { communityId: community.id, userId: hold.targetUserId },
    });
    if (!ban) {
      // The bar was lifted underneath the hold. There is nothing left to make
      // permanent, and signing would otherwise re-bar someone a moderator has
      // deliberately let back in.
      await this.ratifications.update(
        { id: hold.id, status: CommunityBanRatificationStatus.Pending },
        {
          status: CommunityBanRatificationStatus.Withdrawn,
          decidedAt: new Date(),
        },
      );
      throw new ConflictException(
        'That bar has already been lifted, so there is nothing left to confirm.',
      );
    }

    const now = new Date();
    const isRatifying = dto.decision === 'ratify';

    await this.dataSource.transaction(async (manager) => {
      // Claim the transition with a conditional UPDATE before doing anything
      // consequential, the race-safe shape the platform hold and
      // `triageJoinRequest` both use: two moderators signing the same hold at
      // the same instant must not both apply the bar and both write an entry.
      const claimed = await manager.update(
        CommunityBanRatification,
        { id: hold.id, status: CommunityBanRatificationStatus.Pending },
        {
          status: isRatifying
            ? CommunityBanRatificationStatus.Ratified
            : CommunityBanRatificationStatus.Declined,
          decidedBy: actorUserId,
          decidedAt: now,
          decisionNote: dto.note ?? null,
        },
      );
      if (claimed.affected !== 1) {
        throw new ConflictException(
          'Someone else decided this bar while you were looking at it.',
        );
      }

      if (isRatifying) {
        await manager.update(CommunityBan, { id: ban.id }, { expiresAt: null });
      }
    });

    hold.status = isRatifying
      ? CommunityBanRatificationStatus.Ratified
      : CommunityBanRatificationStatus.Declined;
    hold.decidedBy = actorUserId;
    hold.decidedAt = now;
    hold.decisionNote = dto.note ?? null;
    if (isRatifying) ban.expiresAt = null;

    await this.logGovernanceEntry(
      community.id,
      actorUserId,
      isRatifying
        ? GovernanceLogAction.MemberBanRatified
        : GovernanceLogAction.MemberBanDeclined,
      hold.targetUserId,
      {
        ...(hold.note ? { reason: hold.note } : {}),
        ...(dto.note ? { note: dto.note } : {}),
        banExpiresAt: ban.expiresAt?.toISOString() ?? null,
      },
    );

    if (isRatifying) {
      // Written in the RATIFIER's name, under the action the appeal path
      // already knows (`COMMUNITY_BAN_AUDIT_ACTION`), at the moment the bar
      // actually becomes permanent. `duration: null` is what says "no end
      // date" there, so the member's appeal resolves against the permanent bar
      // rather than the 30-day one the removal recorded.
      await this.governanceLog.logModerationAudit({
        actorUserId,
        action: COMMUNITY_BAN_AUDIT_ACTION,
        targetUserId: hold.targetUserId,
        note: hold.note,
        duration: null,
      });
      await this.notifyBarMadePermanent(community, ban);
    }

    return (await this.toRows([hold], community, actorUserId))[0]!;
  }

  /**
   * Mark every pending hold in one community whose window has closed as
   * expired, and record the lapse.
   *
   * Deliberately does NOT touch the `community_bans` row: the 30-day term was
   * written at the moment of the removal, so the sanction this lapse settles
   * on is already in force and already correct. Writing it again here would be
   * a second authority over the same column with no way to order the two.
   *
   * Returns the rows it expired so a caller can react. The conditional
   * `UPDATE ... WHERE status = 'pending'` is what makes this safe to run from
   * any read: a hold signed between the select and the update is never
   * clobbered.
   */
  async expireDueHolds(
    communityId: string,
    now: Date = new Date(),
  ): Promise<CommunityBanRatification[]> {
    const due = await this.ratifications.find({
      where: {
        communityId,
        status: CommunityBanRatificationStatus.Pending,
        expiresAt: LessThanOrEqual(now),
      },
      // Bounded: this runs on every read of the queue, and an unbounded sweep
      // would make one slow request out of a backlog. Anything left over is
      // picked up by the next read, and the member's terms are unaffected
      // either way.
      take: 50,
    });
    if (!due.length) return [];

    const expired: CommunityBanRatification[] = [];
    for (const hold of due) {
      const result = await this.ratifications.update(
        { id: hold.id, status: CommunityBanRatificationStatus.Pending },
        { status: CommunityBanRatificationStatus.Expired, decidedAt: now },
      );
      if (result.affected === 1) {
        hold.status = CommunityBanRatificationStatus.Expired;
        hold.decidedAt = now;
        expired.push(hold);
      }
    }

    // The lapse is a governance outcome and belongs in the community's own
    // history: a permanent bar that was asked for and never signed is a fact
    // about how this room's staff handled a case, and without this entry the
    // record would show a proposal and then silence. `actorUserId` is the
    // proposer, because nobody else acted.
    for (const hold of expired) {
      await this.logGovernanceEntry(
        communityId,
        hold.requestedBy,
        GovernanceLogAction.MemberBanHoldExpired,
        hold.targetUserId,
        {
          ...(hold.note ? { reason: hold.note } : {}),
          ratificationExpiresAt: hold.expiresAt.toISOString(),
        },
      );
    }

    return expired;
  }

  /**
   * `targetUserId -> holdId` for every hold still open in one community, so
   * the ban list can flag which bars somebody has asked to make permanent.
   *
   * One query for the whole page. Expiry is the caller's to run first: this
   * reads the stored status and says nothing about the clock, exactly like the
   * queue read above.
   */
  async pendingHoldIdsByTargetUser(
    communityId: string,
  ): Promise<Map<string, string>> {
    const openHolds = await this.ratifications.find({
      where: {
        communityId,
        status: CommunityBanRatificationStatus.Pending,
      },
      select: { id: true, targetUserId: true },
    });
    return new Map(openHolds.map((hold) => [hold.targetUserId, hold.id]));
  }

  /**
   * Withdraw any pending hold on a member in one community.
   *
   * Called when the basis for the permanent bar goes away underneath it: a
   * moderator lifting the bar entirely. Without this, a bar could be lifted on
   * Tuesday and made permanent on Wednesday by a second moderator signing a
   * hold nobody had told about the lift.
   */
  async withdrawPendingHold(
    communityId: string,
    targetUserId: string,
  ): Promise<boolean> {
    const result = await this.ratifications.update(
      {
        communityId,
        targetUserId,
        status: CommunityBanRatificationStatus.Pending,
      },
      {
        status: CommunityBanRatificationStatus.Withdrawn,
        decidedAt: new Date(),
      },
    );
    return (result.affected ?? 0) > 0;
  }

  /**
   * Hand-map a page of holds, resolving every person through one batched
   * `MemberLookup.byUserIds` call and every current bar through one batched
   * ban read, rather than two queries per row.
   */
  private async toRows(
    rows: CommunityBanRatification[],
    community: Community,
    viewerUserId: string,
  ): Promise<CommunityBanRatificationDTO[]> {
    if (!rows.length) return [];

    const referencedUserIds = [
      ...new Set(
        rows
          .flatMap((row) => [row.targetUserId, row.requestedBy, row.decidedBy])
          .filter((value): value is string => value !== null),
      ),
    ];
    const refByUserId: Map<string, MemberRef> = await new MemberLookup(
      this.profiles,
    ).byUserIds(referencedUserIds);

    const targetUserIds = [...new Set(rows.map((row) => row.targetUserId))];
    const currentBans = await this.bans.find({
      where: { communityId: community.id, userId: In(targetUserIds) },
    });
    const banByUserId = new Map(currentBans.map((ban) => [ban.userId, ban]));

    const now = new Date();
    return rows.map((row) =>
      toCommunityBanRatificationDTO(
        row,
        refByUserId.get(row.targetUserId) ?? null,
        row.requestedBy ? (refByUserId.get(row.requestedBy) ?? null) : null,
        row.decidedBy ? (refByUserId.get(row.decidedBy) ?? null) : null,
        community.rulesVersion,
        viewerUserId,
        banByUserId.get(row.targetUserId)?.expiresAt ?? null,
        now,
      ),
    );
  }

  /**
   * Own try/catch, the contract every logging helper in this module follows:
   * the decision has already committed, and a failed log write must never be
   * reported to the moderator as a failed signature.
   */
  private async logGovernanceEntry(
    communityId: string,
    actorUserId: string | null,
    action: GovernanceLogAction,
    targetUserId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.governanceLog.log({
        communityId,
        actorUserId,
        action,
        targetUserId,
        metadata,
      });
    } catch (error) {
      this.logger.warn(
        `Community ${communityId} recorded a "${action}" decision about user ${targetUserId}, but the governance log entry could not be written: ${String(error)}.`,
      );
    }
  }

  /**
   * Tell the member their bar no longer has an end date.
   *
   * Only a RATIFICATION notifies. A decline and a lapse both leave the terms
   * the member was already given at removal exactly as they were, and telling
   * someone that a punishment they were never told was pending has been
   * refused would introduce the worry rather than settle it.
   *
   * Best effort and post-commit, matching every other notify helper here. No
   * `actorId` is passed, so the bell never names which moderator signed.
   */
  private async notifyBarMadePermanent(
    community: Community,
    ban: CommunityBan,
  ): Promise<void> {
    try {
      await this.notifications.create(
        ban.userId,
        NotificationType.CommunityBanned,
        {
          source: 'community',
          communitySlug: community.slug,
          communityName: community.name,
          reason: ban.reason,
          expiresAt: null,
          ruleText: ban.ruleText,
          ruleIndex: ban.ruleIndex,
          ruleVersion: ban.ruleVersion,
        },
      );
    } catch {
      // Intentionally ignored: the decision already committed.
    }
  }
}

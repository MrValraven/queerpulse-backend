import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  LessThanOrEqual,
  Repository,
} from 'typeorm';
import {
  ACCOUNT_REMOVED,
  AccountRemovedEvent,
} from '../ban-evasion/ban-evasion.events';
import { RemovalKind } from '../ban-evasion/entities/removed-account-signal.entity';
import { AuthService } from '../auth/auth.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { AccountEnforcementService } from './account-enforcement.service';
import {
  BAN_DECLINED_AUDIT_ACTION,
  BAN_HOLD_EXPIRED_AUDIT_ACTION,
} from './ban-ratification-window';
import { RatifyBanDto } from './dto/ratify-ban.dto';
import {
  BanRatification,
  BanRatificationStatus,
} from './entities/ban-ratification.entity';
import { ModAuditService } from './mod-audit.service';
import {
  BanRatificationDTO,
  toBanRatificationDTO,
} from './moderation-response';

/**
 * The second signature on a permanent ban (TS-12).
 *
 * Article VIII promises removal is "ratified by one additional independent
 * moderator". Until this service, one moderator could permanently ban a member
 * in a single `PATCH /mod/reports/:id`, or across up to 100 reports at once
 * through `PATCH /mod/reports/bulk`, with no pending state and no second
 * signature anywhere in the system. That is also the one control that would
 * contain a compromised moderator account, which is why it exists here rather
 * than as a convention moderators are asked to follow.
 *
 * THE THREE DECISIONS THIS FLOW MAKES, and why:
 *
 * 1. WHAT HAPPENS TO THE MEMBER WHILE A BAN IS PENDING: they are suspended,
 *    with `suspended_until` set to the hold's own expiry. See
 *    {@link BAN_INTERIM_SUSPENSION} on the entity for the full argument. The
 *    audit row says so (`ban_pending_ratification`, carrying the hold's expiry
 *    as its `duration`), so the trail states which choice was made.
 *
 * 2. WHAT EXPIRY MEANS: the ban LAPSES. It does not escalate to an admin.
 *    Escalation reads as the safer option and is the more dangerous one: it
 *    lets a ban nobody was willing to confirm become permanent through
 *    inaction, which is the exact failure Article VIII's second signature
 *    exists to prevent, and it puts the burden of an unratified decision on the
 *    member rather than on the moderators who did not act. Lapsing fails safe
 *    for the member and costs the platform nothing it cannot recover: a
 *    moderator who still wants the ban can open a new hold the moment the old
 *    one expires, with the evidence unchanged. The interim suspension is
 *    time-boxed to the same instant, so it lapses through `JwtStrategy`'s
 *    existing lapsed-suspension path with no sweep job involved.
 *
 * 3. WHO MAY RATIFY: any Moderator or Admin EXCEPT the moderator who asked.
 *    An admin may not self-ratify either, and that is deliberate rather than an
 *    oversight. "One additional independent moderator" counts people, and an
 *    admin acting alone is one person; more to the point, the scenario this
 *    control is for is a compromised staff account, and a compromised account
 *    is likelier to be the one holding the highest role, so an admin carve-out
 *    would put the exemption exactly where the risk is. An admin ratifying
 *    ANOTHER moderator's hold is the normal escalation path and is fully
 *    allowed.
 *
 * EXPIRY IS LAZY, never a cron. `expireDueHolds()` runs at the top of every
 * read and before every decision, matching how community bans expire
 * (`CommunitiesService.assertNotBanned`) and how `JwtStrategy` clears a lapsed
 * restriction. Nothing in the product depends on a hold being marked expired at
 * the exact second it lapses: the member's suspension has already lapsed by
 * then on its own timer.
 */
@Injectable()
export class BanRatificationService {
  constructor(
    @InjectRepository(BanRatification)
    private readonly ratifications: Repository<BanRatification>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly audit: ModAuditService,
    private readonly enforcement: AccountEnforcementService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Marks every pending hold whose window has closed as expired.
   *
   * Deliberately does NOT touch the member's account: the interim suspension
   * was written with `suspended_until` set to the hold's own expiry, so it has
   * already lapsed by the time this runs, and `JwtStrategy` flips the member
   * back to `Active` on their next request. Writing the account here as well
   * would be a second authority over the same field with no way to order the
   * two.
   *
   * Returns the rows it expired so the caller can write the audit trail. The
   * conditional `UPDATE ... WHERE status = 'pending'` is what makes this safe
   * to run from any read: a hold ratified between the select and the update is
   * never clobbered.
   */
  async expireDueHolds(now: Date = new Date()): Promise<BanRatification[]> {
    const due = await this.ratifications.find({
      where: {
        status: BanRatificationStatus.Pending,
        expiresAt: LessThanOrEqual(now),
      },
      // Bounded: this runs on every read of the queue, and an unbounded sweep
      // would make one slow request out of a backlog. Anything left over is
      // picked up by the next read.
      take: 50,
    });
    if (!due.length) return [];

    const expired: BanRatification[] = [];
    for (const hold of due) {
      const result = await this.ratifications.update(
        { id: hold.id, status: BanRatificationStatus.Pending },
        { status: BanRatificationStatus.Expired, decidedAt: now },
      );
      if (result.affected === 1) {
        hold.status = BanRatificationStatus.Expired;
        hold.decidedAt = now;
        expired.push(hold);
      }
    }

    // The lapse is a moderation outcome and belongs in the immutable trail: a
    // ban that was asked for and never confirmed is a fact about how the team
    // handled a case, and without this row the record would show a ban request
    // and then silence. `actorId` is the moderator who asked, because nobody
    // else acted.
    for (const hold of expired) {
      if (!hold.requestedBy) continue;
      await this.audit.writeAuditLog(
        hold.reportId,
        hold.requestedBy,
        BAN_HOLD_EXPIRED_AUDIT_ACTION,
        hold.reasonCode ?? undefined,
        hold.note ?? undefined,
        hold.expiresAt.toISOString(),
      );
    }

    return expired;
  }

  /**
   * Withdraws any pending hold on a member, inside the caller's transaction.
   *
   * Called when the basis for the ban goes away underneath it: an overturned
   * appeal, or a moderator lifting the interim suspension by hand. Without
   * this, a member could win their appeal on Tuesday and be banned on
   * Wednesday by a second moderator ratifying a hold nobody had told about the
   * overturn.
   */
  async withdrawPendingHold(
    manager: EntityManager,
    targetUserId: string,
  ): Promise<boolean> {
    const result = await manager.update(
      BanRatification,
      { targetUserId, status: BanRatificationStatus.Pending },
      { status: BanRatificationStatus.Withdrawn, decidedAt: new Date() },
    );
    return (result.affected ?? 0) > 0;
  }

  /** GET /mod/ratifications — the holds a second moderator can act on. */
  async list(
    status: BanRatificationStatus = BanRatificationStatus.Pending,
  ): Promise<BanRatificationDTO[]> {
    await this.expireDueHolds();

    const rows = await this.ratifications.find({
      where: { status },
      // Soonest to lapse first on the pending queue: the hold about to expire
      // is the one a second moderator has to look at today. Every other status
      // is a history view, where newest first is the useful order.
      order:
        status === BanRatificationStatus.Pending
          ? { expiresAt: 'ASC' }
          : { createdAt: 'DESC' },
      take: 100,
    });
    return this.toRows(rows);
  }

  /**
   * PATCH /mod/ratifications/:id — the second signature, or the refusal.
   *
   * On RATIFY the permanent ban lands: `status = Suspended` with
   * `suspended_until = NULL` (the shape `AccountEnforcementService` has always
   * written for a ban), a `ban` audit row in the RATIFIER's name, sessions
   * revoked, and `ACCOUNT_REMOVED` emitted. That emit fires here and only here
   * for a report-driven ban, which is the point: it means "this account is
   * gone", and it must never fire on a hold that has not taken effect.
   *
   * On DECLINE the member is restored and a `ban_declined` row records that one
   * moderator refused another's ban. That refusal is worth as much in the trail
   * as the ban would have been.
   */
  async decide(
    id: string,
    actorId: string,
    actorRole: string,
    dto: RatifyBanDto,
  ): Promise<BanRatificationDTO> {
    await this.expireDueHolds();

    const hold = await this.ratifications.findOne({ where: { id } });
    if (!hold) {
      throw new NotFoundException('That ban is not waiting on anyone.');
    }
    if (hold.status !== BanRatificationStatus.Pending) {
      throw new ConflictException(
        'That ban has already been decided or has lapsed.',
      );
    }
    // The whole point of the control. `requestedBy` is NULL only when the
    // requesting moderator has since erased their account, and an unknown
    // requester can never equal a live `actorId`, so this fails to "not you".
    if (hold.requestedBy && hold.requestedBy === actorId) {
      throw new ForbiddenException(
        'You asked for this ban, so you cannot be the moderator who confirms it. It needs a second pair of eyes.',
      );
    }
    const role = actorRole as UserRole;
    if (role !== UserRole.Moderator && role !== UserRole.Admin) {
      throw new ForbiddenException(
        'Confirming a permanent ban requires a moderator or admin role.',
      );
    }

    const now = new Date();
    const isRatifying = dto.decision === 'ratify';

    const committed = await this.dataSource.transaction(async (manager) => {
      // Claim the transition with a conditional UPDATE before doing anything
      // consequential, the same race-safe shape `actOnReport` uses: two
      // moderators confirming the same hold at the same instant must not both
      // apply the ban and both write an audit row.
      const claimed = await manager.update(
        BanRatification,
        { id: hold.id, status: BanRatificationStatus.Pending },
        {
          status: isRatifying
            ? BanRatificationStatus.Ratified
            : BanRatificationStatus.Declined,
          decidedBy: actorId,
          decidedAt: now,
          decisionNote: dto.note ?? null,
        },
      );
      if (claimed.affected !== 1) {
        throw new ConflictException(
          'Another moderator decided this ban while you were looking at it.',
        );
      }

      if (isRatifying) {
        await this.enforcement.applyRatifiedBan(manager, hold.targetUserId);
        // Written in the RATIFIER's name, under the canonical `ban` code, at
        // the moment the ban actually takes effect. That is what makes the
        // member's appeal against "the ban" resolve to a real row, and what
        // keeps the conflict-of-interest guard in `reviewAppeal` pointed at a
        // moderator who was genuinely part of the decision.
        await this.audit.writeAuditLog(
          hold.reportId,
          actorId,
          'ban',
          hold.reasonCode ?? undefined,
          hold.note ?? undefined,
          undefined,
          manager,
        );
      } else {
        await this.enforcement.restoreUser(manager, hold.targetUserId);
        await this.audit.writeAuditLog(
          hold.reportId,
          actorId,
          BAN_DECLINED_AUDIT_ACTION,
          hold.reasonCode ?? undefined,
          dto.note ?? undefined,
          undefined,
          manager,
        );
      }

      hold.status = isRatifying
        ? BanRatificationStatus.Ratified
        : BanRatificationStatus.Declined;
      hold.decidedBy = actorId;
      hold.decidedAt = now;
      hold.decisionNote = dto.note ?? null;
      return hold;
    });

    if (isRatifying) {
      // Post-commit, outside the transaction, and in this order for the same
      // reasons `actOnReport` gives: revocation touches another aggregate and
      // must not roll a committed ban back, and a ban-evasion signal that fails
      // to record must never undo the removal it describes.
      await this.auth.revokeAllForUser(committed.targetUserId);
      const removed: AccountRemovedEvent = {
        userId: committed.targetUserId,
        removalKind: RemovalKind.PlatformBan,
        communityId: null,
        removedAt: now,
      };
      this.eventEmitter.emit(ACCOUNT_REMOVED, removed);
    }

    await this.notifyMemberBestEffort(committed, isRatifying, actorId);

    return (await this.toRows([committed]))[0]!;
  }

  /**
   * Tells the member what happened to the hold.
   *
   * On a ratified ban this is the message they read on the way out, carrying
   * the first moderator's words (the note they wrote for the member, not the
   * second moderator's internal one). On a declined ban it is the message
   * saying their account is back, which matters more: an interim suspension
   * they were never told the end of is indistinguishable from a ban.
   *
   * Best-effort and post-commit, matching every other notification in this
   * module. No actor is passed, so it bypasses the block/mute filter and the
   * per-type preference gate: a moderation outcome is the platform's word.
   */
  private async notifyMemberBestEffort(
    hold: BanRatification,
    isRatifying: boolean,
    actorId: string,
  ): Promise<void> {
    if (hold.targetUserId === actorId) return;
    try {
      await this.notifications.create(
        hold.targetUserId,
        NotificationType.ModerationOutcome,
        {
          source: 'moderation',
          // The member is told the OUTCOME, in the vocabulary the notification
          // catalogue already has: a ratified hold is a `ban`, a declined one
          // reuses the lift code the restore path writes.
          action: isRatifying ? 'ban' : 'suspension_lifted',
          reasonCode: hold.reasonCode ?? 'other',
          note: hold.note ?? '',
        },
      );
    } catch {
      // Intentionally ignored — the decision already committed.
    }
  }

  private async toRows(rows: BanRatification[]): Promise<BanRatificationDTO[]> {
    const now = new Date();
    // One batched name lookup for the page rather than two per row, matching
    // `ModAuditService.auditTrail`.
    const actorIds = [
      ...new Set(
        rows
          .flatMap((row) => [row.requestedBy, row.decidedBy])
          .filter((value): value is string => value !== null),
      ),
    ];
    const names = await this.audit.namesForUserIds(actorIds);
    const nameOf = (userId: string | null): string =>
      userId ? (names.get(userId) ?? 'Member') : 'Deleted member';

    return rows.map((row) =>
      toBanRatificationDTO(
        row,
        nameOf(row.requestedBy),
        row.decidedBy ? nameOf(row.decidedBy) : null,
        now,
      ),
    );
  }

  /**
   * The live account state behind a hold, for callers that need to know whether
   * the member is still under the interim suspension. Read-only.
   */
  async statusOfTarget(targetUserId: string): Promise<UserStatus | null> {
    const user = await this.users.findOne({ where: { id: targetUserId } });
    return user ? user.status : null;
  }
}

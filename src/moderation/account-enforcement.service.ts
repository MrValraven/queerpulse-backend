import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { Report, ReportSubjectType } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { LiftRestrictionDto } from './dto/lift-restriction.dto';
import { LiftSuspensionDto } from './dto/lift-suspension.dto';
import { ModActionCode } from './dto/mod-action.dto';
import { ModAuditService } from './mod-audit.service';
import { parseDuration } from './parse-duration';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ACCOUNT_REMOVED,
  AccountRemovedEvent,
} from '../ban-evasion/ban-evasion.events';
import { RemovalKind } from '../ban-evasion/entities/removed-account-signal.entity';
import { ReportSubjectResolverService } from './report-subject-resolver.service';
import {
  BAN_INTERIM_SUSPENSION,
  BanRatification,
  BanRatificationStatus,
} from './entities/ban-ratification.entity';
import {
  BAN_PENDING_AUDIT_ACTION,
  banHoldExpiryFrom,
} from './ban-ratification-window';

// Loose enough to guard `Repository.findOne({ where: { userId: subjectId } })`
// from a Postgres "invalid input syntax for type uuid" error when a
// non-member subjectId (a slug, a content id, ...) is checked against a
// `uuid` column.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Default `restrict` duration when the caller doesn't send one. The moderation
 * queue drawer (`AdminReportDrawer.tsx`) has no duration input for ANY action
 * today (`ban` is always sent duration-less too, and is permanent as a
 * result) — a `restrict` needs a duration, so an unspecified one falls back to
 * this rather than 400ing on every real click. A week is long enough to change
 * a member's next actions, short enough that a mis-click self-corrects on its
 * own. A mis-click can also be undone directly now:
 * `PATCH /admin/members/:id/restriction` lifts a restriction (see
 * `AdminMemberModerationService.liftRestriction`).
 */
const DEFAULT_RESTRICTION_DURATION = '7d';

/**
 * The account-enforcement cluster, extracted from `ModerationService` as a
 * behavior-preserving concern split: applying a moderator action to the
 * reported member (`enforceAgainstUser`), restoring a member
 * (`restoreUser`/`liftSuspension`/`restoreSuspensionForAppeal`), keeping an
 * open deactivation row's `previousStatus` in step, and resolving a report to
 * the member behind it (`resolveReportedProfile`, shared with the read path).
 *
 * The transaction-bearing helpers (`enforceAgainstUser`, `restoreUser`,
 * `restoreSuspensionForAppeal`, `syncDeactivationPreviousStatus`) take the
 * caller's `EntityManager` so they enlist in `ModerationService`'s existing
 * transactions unchanged — atomicity is preserved end to end.
 */
@Injectable()
export class AccountEnforcementService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // TS-12. The hold row and the interim suspension are one decision, so they
    // are written by the same service inside one transaction. Injected as a
    // repository rather than through `BanRatificationService` on purpose: that
    // service already injects THIS one (to apply or undo the ban when a second
    // moderator decides), and a service-level cycle between the two would need
    // a `forwardRef` to paper over a design that does not need one.
    @InjectRepository(BanRatification)
    private readonly banRatifications: Repository<BanRatification>,
    private readonly dataSource: DataSource,
    private readonly audit: ModAuditService,
    // Resolves a report's subject to the member behind it for EVERY subject
    // type, which is what lets a moderator sanction the author of reported
    // content (TS-03) instead of only the subject of a `member` report.
    // Read-only and dependency-light (it holds the `DataSource` and nothing
    // else), so injecting it adds no edge to the module graph.
    private readonly subjectResolver: ReportSubjectResolverService,
    // Emits `ACCOUNT_REMOVED` after a permanent ban commits, so the
    // ban-evasion module can keep correlation material for the invite
    // review queue.
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // PATCH /mod/users/:userId/suspension — lift a suspension or ban.
  //
  // Without this, `ban` (permanent, `suspendedUntil = null`) would be
  // irreversible through the API: expiry never fires for it, and the only other
  // route back — an appeal overturn — is unreachable because nothing creates
  // appeals (`POST /appeals` does not exist; see `appeal.entity.ts`).
  async liftSuspension(
    userId: string,
    actorId: string,
    dto: LiftSuspensionDto,
  ): Promise<{ userId: string; status: UserStatus }> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Idempotent, matching this codebase's promotion/RSVP/vouch/accept
    // convention: lifting a suspension that is not there is a no-op, not a 409.
    if (user.status !== UserStatus.Suspended) {
      return { userId: user.id, status: user.status };
    }

    await this.dataSource.transaction(async (manager) => {
      await this.restoreUser(manager, user.id);
      // TS-12. Lifting the suspension has to close the hold behind it too.
      // Otherwise a moderator could lift a member's interim suspension on
      // Tuesday and a second moderator could ratify the same, still-open hold
      // on Wednesday, permanently banning someone a colleague had just let back
      // in. A member with no hold is unaffected: the conditional update simply
      // matches nothing.
      await manager.update(
        BanRatification,
        { targetUserId: user.id, status: BanRatificationStatus.Pending },
        {
          status: BanRatificationStatus.Withdrawn,
          decidedBy: actorId,
          decidedAt: new Date(),
        },
      );
      await this.audit.writeAuditLog(
        dto.reportId ?? null,
        actorId,
        'suspension_lifted',
        dto.reasonCode,
        dto.note,
        undefined,
        manager,
      );
    });

    return { userId: user.id, status: UserStatus.Active };
  }

  /**
   * The member's live scoped-restriction state, for the admin member drawer's
   * "lift restriction" control. Read-only: `restricted` is not exposed on any
   * other admin DTO, and the drawer has to know whether there is anything to
   * lift before it offers the button.
   *
   * NOTE the expiry semantics: `restricted_until` in the PAST means the
   * restriction has already lapsed and `JwtStrategy` will clear the flags on
   * the member's next request (see its `restrictedUntil` branch). This reports
   * `restricted: false` for that case rather than offering a lift of something
   * already gone.
   */
  async restrictionState(userId: string): Promise<{
    userId: string;
    restricted: boolean;
    restrictedUntil: Date | null;
  }> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Member not found.');
    }
    const hasLapsed =
      user.restrictedUntil !== null && user.restrictedUntil <= new Date();
    return {
      userId: user.id,
      restricted: user.restricted && !hasLapsed,
      restrictedUntil: user.restrictedUntil,
    };
  }

  /**
   * PATCH /admin/members/:id/restriction — lift a scoped restriction.
   *
   * The counterpart `liftSuspension` has always had, and `restrict` never did:
   * before this, the only way out of a restriction was winning an appeal
   * (`ModerationService.revertOriginalAction`) or waiting for
   * `restricted_until` to lapse. A moderator who restricted the wrong member,
   * or one whose situation changed, had no way back.
   *
   * Idempotent, matching `liftSuspension` and this codebase's
   * promotion/RSVP/vouch convention: lifting a restriction that is not there is
   * a no-op returning the current state, not a 409. Deliberately does NOT touch
   * `status`/`suspendedUntil` — a restriction never changed them (see
   * `enforceAgainstUser`) — and does NOT revoke sessions, for the same reason
   * applying one does not.
   */
  async liftRestriction(
    userId: string,
    actorId: string,
    dto: LiftRestrictionDto,
  ): Promise<{
    userId: string;
    restricted: boolean;
    restrictedUntil: Date | null;
  }> {
    const state = await this.restrictionState(userId);
    if (!state.restricted) {
      return state;
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        User,
        { id: userId },
        { restricted: false, restrictedUntil: null },
      );
      // Same action code the appeal-overturn path writes
      // (`ModerationService.revertOriginalAction`), so both routes out of a
      // restriction read as one thing in the audit feed.
      await this.audit.writeAuditLog(
        dto.reportId ?? null,
        actorId,
        'restriction_lifted',
        dto.reasonCode,
        dto.note,
        undefined,
        manager,
      );
    });

    return { userId, restricted: false, restrictedUntil: null };
  }

  /**
   * Restores the member behind an overturned appeal's report, if there is one
   * and they are actually suspended.
   *
   * Silent when the appeal has no `reportId`, the report's subject resolves to
   * no account, or that member is not suspended — an overturn must still record its decision
   * in all of those cases rather than 400 on a bookkeeping detail.
   */
  async restoreSuspensionForAppeal(
    manager: EntityManager,
    reportId: string | null,
  ): Promise<void> {
    if (!reportId) return;

    const report = await manager.findOne(Report, { where: { id: reportId } });
    if (!report) return;

    // Resolves the author on a content report too, not just the subject of a
    // `member` one: now that `suspend`/`ban` can land on the author of reported
    // content (TS-03), an overturned appeal has to be able to reach the same
    // account the sanction did.
    const userId = await this.resolveEnforcementTargetUserId(report);
    if (!userId) return;

    const user = await manager.findOne(User, { where: { id: userId } });
    if (!user || user.status !== UserStatus.Suspended) return;

    await this.restoreUser(manager, user.id);
  }

  /**
   * Applies a moderator action to the member a report resolves to, if the
   * action is one that has an effect on an account.
   *
   * That member is the reported member on a `member` report and the AUTHOR of
   * the reported content on every other subject type (TS-03) — see
   * `resolveEnforcementTargetUserId`. The house account, staff accounts, the
   * deactivation `previousStatus` sync and the restriction-versus-lockout split
   * below all apply identically whichever way the member was reached.
   *
   * Returns the affected user's id (so the caller can revoke their sessions
   * outside the transaction) alongside the sanction's expiry — a `Date` for a
   * time-boxed suspension, a restriction, or a ban waiting on ratification — so
   * the caller can put "until X" in the outcome notification. Returns `null`
   * when the action was not an enforcement action.
   *
   * `ban` NO LONGER REMOVES THE ACCOUNT HERE (TS-12). It opens a ratification
   * hold and suspends the member for the length of that hold, returning
   * `kind: 'ban_pending'`. The permanent ban lands in `applyRatifiedBan`, called
   * by `BanRatificationService.decide` once a second, different moderator
   * confirms it. Nothing about this delays a content takedown:
   * `hide_content`/`remove_content` are separate actions and never pass through
   * here at all.
   *
   * `restrict` writes the scoped restriction (`User.restricted` +
   * `restrictedUntil`), enforced by `NotRestrictedGuard` on the specific write
   * actions it gates (forum thread + reply creation) — NOT the full
   * suspend/ban lockout `ActiveMemberGuard` enforces. A restricted member stays
   * `Active` and keeps every other read/write. This used to be a documented
   * no-op ("no scoped-restriction model in this codebase") — it now is one.
   */
  async enforceAgainstUser(
    manager: EntityManager,
    report: Report,
    dto: {
      action: ModActionCode;
      duration?: string;
      reasonCode?: string;
      note?: string;
    },
    // The moderator asking. Recorded on the ratification hold a `ban` opens, so
    // the second moderator can see whose ban they are being asked to confirm,
    // and so `BanRatificationService.decide` can refuse to let them confirm
    // their own.
    actorId?: string,
  ): Promise<{
    userId: string;
    suspendedUntil: Date | null;
    /**
     * Discriminates a `restrict` result from `suspend`/`ban`: callers must NOT
     * revoke the member's sessions for a restriction (see this method's doc
     * comment — it is deliberately not a lockout), only for the two actions
     * that actually change `status`.
     *
     * `ban_pending` (TS-12) is a `ban` that has NOT removed anyone yet: the
     * member is suspended for the length of the ratification hold and the
     * account action waits on a second moderator. Callers must revoke sessions
     * for it (it IS a suspension) and must NOT emit `ACCOUNT_REMOVED` for it,
     * because nothing has been removed. That emit belongs to
     * `BanRatificationService.decide`, at the moment the ban takes effect.
     */
    kind: 'suspend' | 'ban' | 'restrict' | 'ban_pending';
    /** Only on `ban_pending`: the hold a second moderator has to act on. */
    ratificationId?: string;
  } | null> {
    if (
      dto.action !== 'suspend' &&
      dto.action !== 'ban' &&
      dto.action !== 'restrict'
    ) {
      return null;
    }

    // TS-03: these three actions used to 400 on every non-`member` report, so
    // a post that outs someone could only be hidden and the person behind it
    // had to be found by hand, through a path that recorded no link to the
    // report. The subject now resolves to its author for every subject type
    // that has one, and the audit row `actOnReport` writes carries the
    // `reportId`, so the sanction is linked to the evidence and appealable as
    // that decision.
    const userId = await this.resolveEnforcementTargetUserId(report);
    if (!userId) {
      throw new BadRequestException(
        `Could not resolve the "${report.subjectType}" this report names to an account. ` +
          'Act on the content instead, or find the member and act from their drawer.',
      );
    }

    const now = new Date();

    if (dto.action === 'restrict') {
      // No permanent/indefinite restriction — see `User.restricted`'s doc
      // comment — so this is always time-boxed, falling back to
      // `DEFAULT_RESTRICTION_DURATION` when the caller sends none.
      const restrictedUntil = parseDuration(
        dto.duration ?? DEFAULT_RESTRICTION_DURATION,
        now,
      );

      const restrictedUser = await manager.findOne(User, {
        where: { id: userId },
      });
      if (!restrictedUser) {
        throw new BadRequestException(
          'Could not restrict the reported member.',
        );
      }
      // Same house-account and staff carve-outs as suspend/ban below. The
      // house account has `role = member` and `is_system = true`, so the role
      // check alone let a `member`-subject report against its slug restrict
      // it (BE-COM-33) — the direct admin path (`restrictMember`) has always
      // refused this.
      if (restrictedUser.isSystem) {
        throw new ForbiddenException('The house account cannot be restricted.');
      }
      if (restrictedUser.role !== UserRole.Member) {
        throw new ForbiddenException(
          'Moderation actions cannot target staff accounts.',
        );
      }

      // Deliberately does NOT touch `status`/`suspendedUntil` or run
      // `syncDeactivationPreviousStatus`: a restriction never changes what the
      // member's account status is, only what a couple of specific write
      // actions accept while it's active (see `NotRestrictedGuard`).
      await manager.update(
        User,
        { id: userId },
        { restricted: true, restrictedUntil },
      );

      return { userId, suspendedUntil: restrictedUntil, kind: 'restrict' };
    }

    // `ban` is permanent (NULL never expires); `suspend` is time-boxed.
    // Requiring exactly one of these shapes means a missing or malformed
    // duration can never quietly become a permanent ban.
    if (dto.action === 'suspend' && !dto.duration) {
      throw new BadRequestException('A suspension requires a duration.');
    }
    if (dto.action === 'ban' && dto.duration) {
      throw new BadRequestException(
        'A ban is permanent and cannot take a duration. Use "suspend" for a time-limited action.',
      );
    }
    const suspendedUntil =
      dto.action === 'ban' ? null : parseDuration(dto.duration as string, now);

    const user = await manager.findOne(User, { where: { id: userId } });
    if (!user) {
      throw new BadRequestException('Could not suspend the reported member.');
    }

    // The house/system account is never a legitimate enforcement target: it
    // carries `role = member` with `is_system = true`, so the role check below
    // does not catch it and a `ban` resolved from a report against its slug
    // would suspend it and run `revokeAllForUser` on it (BE-COM-33). Mirrors
    // the same guard on the direct admin path (`restrictMember`).
    if (user.isSystem) {
      throw new ForbiddenException('The house account cannot be restricted.');
    }

    // A moderator may only enforce against ordinary members — never against
    // another moderator or an admin. Staff accounts are out of scope for this
    // surface entirely (403, not a silent success).
    if (user.role !== UserRole.Member) {
      throw new ForbiddenException(
        'Moderation actions cannot target staff accounts.',
      );
    }

    // A member who had already deactivated keeps `Deactivated` as their live
    // status: they asked to be hidden, and overwriting that would mean this
    // suspension expiring un-hides them later, against their own request. The
    // suspension is still recorded — `previousStatus` below makes them come
    // back Suspended, and `suspendedUntil` keeps the clock — so deactivating
    // is not a way to dodge it either.
    const preserveDeactivation = user.status === UserStatus.Deactivated;

    // TS-12. A ban does not remove the account here any more. It opens a hold
    // for a second moderator and suspends the member for the length of that
    // hold. Everything above this line still runs first, so the house-account
    // and staff carve-outs and the duration validation refuse a bad ban before
    // any hold is opened.
    if (dto.action === 'ban') {
      const hold = await this.openBanHold(manager, {
        targetUserId: userId,
        reportId: report.id,
        requestedBy: actorId ?? null,
        note: dto.note ?? null,
        reasonCode: dto.reasonCode ?? null,
        now,
      });
      await manager.update(
        User,
        { id: userId },
        {
          ...(preserveDeactivation ? {} : { status: UserStatus.Suspended }),
          // The interim suspension expires WITH the hold, which is what makes
          // "nobody ratified it" self-correcting: `JwtStrategy` clears a lapsed
          // suspension on the member's next request, so an unconfirmed ban
          // costs them the hold window and nothing more.
          suspendedUntil: hold.expiresAt,
        },
      );
      await this.syncDeactivationPreviousStatus(
        manager,
        userId,
        UserStatus.Suspended,
      );
      return {
        userId,
        suspendedUntil: hold.expiresAt,
        kind: 'ban_pending',
        ratificationId: hold.id,
      };
    }

    await manager.update(
      User,
      { id: userId },
      {
        ...(preserveDeactivation ? {} : { status: UserStatus.Suspended }),
        suspendedUntil,
      },
    );

    await this.syncDeactivationPreviousStatus(
      manager,
      userId,
      UserStatus.Suspended,
    );

    return {
      userId,
      suspendedUntil,
      kind: 'suspend',
    };
  }

  /**
   * Opens (or joins) the ratification hold for a permanent ban, inside the
   * caller's transaction (TS-12).
   *
   * IDEMPOTENT PER MEMBER, which is what makes a bulk ban correct rather than
   * merely tolerable: a `PATCH /mod/reports/bulk` naming one member across
   * thirty reports must open ONE hold, not thirty, and must not push the
   * member's interim suspension out by another 72 hours on each row. When a
   * hold already stands, the existing one comes back with its ORIGINAL expiry,
   * so a second report cannot silently extend how long someone is suspended
   * before anyone has confirmed anything.
   *
   * `UQ_ban_ratifications_pending_target` (partial unique on `target_user_id
   * WHERE status = 'pending'`) is what actually closes the race between two
   * moderators; the read below fast-paths the ordinary case.
   *
   * A hold whose window has already closed is not an open hold: it is settled
   * as expired and a fresh one is opened, rather than a lapsed row being
   * silently reused with a deadline in the past.
   */
  private async openBanHold(
    manager: EntityManager,
    input: {
      targetUserId: string;
      reportId: string | null;
      requestedBy: string | null;
      note: string | null;
      reasonCode: string | null;
      now: Date;
    },
  ): Promise<BanRatification> {
    const repo = manager.getRepository(BanRatification);
    const existing = await repo.findOne({
      where: {
        targetUserId: input.targetUserId,
        status: BanRatificationStatus.Pending,
      },
    });
    if (existing && existing.expiresAt.getTime() > input.now.getTime()) {
      return existing;
    }
    if (existing) {
      await repo.update(
        { id: existing.id, status: BanRatificationStatus.Pending },
        { status: BanRatificationStatus.Expired, decidedAt: input.now },
      );
    }

    // The display-name snapshot, taken now, is what lets the ratification queue
    // still say who a hold is about after the member is erased — the same
    // reason `mod_audit_logs.target_name` exists.
    const profile = await manager.findOne(Profile, {
      where: { userId: input.targetUserId },
    });
    const targetName = profile
      ? `${profile.firstName} ${profile.lastName}`.trim()
      : null;

    return repo.save(
      repo.create({
        targetUserId: input.targetUserId,
        targetName,
        reportId: input.reportId,
        requestedBy: input.requestedBy,
        note: input.note,
        reasonCode: input.reasonCode,
        interimAction: BAN_INTERIM_SUSPENSION,
        expiresAt: banHoldExpiryFrom(input.now),
        status: BanRatificationStatus.Pending,
      }),
    );
  }

  /**
   * Applies a permanent ban that a second moderator has just ratified (TS-12).
   *
   * The same write `enforceAgainstUser` used to do inline for a `ban`:
   * `status = Suspended` with `suspended_until = NULL`, which is the shape this
   * codebase has always used for "never expires" (see `JwtStrategy`'s
   * lapsed-suspension branch, which treats a NULL as permanent). The
   * `Deactivated` carve-out is preserved for the same reason it is everywhere
   * else here: a member who had already hidden themselves stays hidden, and
   * `previousStatus` is synced so signing back in cannot launder the ban away.
   *
   * The guards (house account, staff accounts, duration validation) are NOT
   * re-run: they were all applied when the hold was opened, and re-running them
   * here would mean a member promoted to moderator between the request and the
   * ratification could not be banned for what they did as a member.
   */
  async applyRatifiedBan(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const user = await manager.findOne(User, { where: { id: userId } });
    const preserveDeactivation = user?.status === UserStatus.Deactivated;
    await manager.update(
      User,
      { id: userId },
      {
        ...(preserveDeactivation ? {} : { status: UserStatus.Suspended }),
        suspendedUntil: null,
      },
    );
    await this.syncDeactivationPreviousStatus(
      manager,
      userId,
      UserStatus.Suspended,
    );
  }

  /**
   * Restricts a member DIRECTLY from the admin drawer (not off a report) —
   * `POST /admin/members/:id/restrict`. Deliberately reuses the exact
   * suspension model `enforceAgainstUser` writes (`status = Suspended` +
   * `suspended_until`) rather than inventing a parallel "restricted" state: a
   * time-boxed `duration` becomes a suspension, an absent one a permanent ban
   * (`suspended_until = null`, never expires). There is no scoped/community
   * restriction model in this codebase, so this is platform-wide.
   *
   * Same guardrails as `enforceAgainstUser`: only ordinary members can be
   * restricted (never a moderator/admin — 403), never the acting admin
   * themselves, never the house account. A member who had already deactivated
   * keeps `Deactivated` as their live status (they asked to be hidden), with
   * `previousStatus` synced to `Suspended` so signing back in cannot launder
   * the restriction away.
   *
   * Returns the member id + the suspension's expiry (`null` = permanent) so the
   * caller can revoke their live sessions and put "restricted until X" in the
   * outcome notification, mirroring `enforceAgainstUser`'s contract.
   */
  async restrictMember(
    userId: string,
    actorId: string,
    dto: {
      action: 'suspend' | 'ban';
      duration?: string;
      reasonCode: string;
      note: string;
    },
  ): Promise<{
    userId: string;
    suspendedUntil: Date | null;
    status: UserStatus;
  }> {
    const now = new Date();
    // `ban` is permanent (NULL never expires); `suspend` is time-boxed.
    // Requiring exactly one of these shapes means a missing or malformed
    // duration can never quietly become a permanent ban.
    if (dto.action === 'suspend' && !dto.duration) {
      throw new BadRequestException(
        'A time-boxed restriction requires a duration.',
      );
    }
    if (dto.action === 'ban' && dto.duration) {
      throw new BadRequestException(
        'A permanent restriction cannot take a duration.',
      );
    }
    const suspendedUntil =
      dto.action === 'ban' ? null : parseDuration(dto.duration as string, now);

    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Member not found.');
    }
    if (user.id === actorId) {
      throw new ForbiddenException('You cannot restrict your own account.');
    }
    if (user.isSystem) {
      throw new ForbiddenException('The house account cannot be restricted.');
    }
    if (user.role !== UserRole.Member) {
      throw new ForbiddenException(
        'Moderation actions cannot target staff accounts.',
      );
    }

    const preserveDeactivation = user.status === UserStatus.Deactivated;

    // TS-12 applies here too, and deliberately so. This route is the admin
    // member drawer's "restrict permanently", and it reaches the same
    // permanent ban the report queue does, without a report and without a
    // second signature. Leaving it outside the ratification requirement would
    // have made the whole control theatre: a compromised staff account would
    // simply use this door instead. So a `ban` here opens the same hold, and
    // the member is suspended for its length rather than removed.
    const holdExpiresAt = await this.dataSource.transaction(
      async (manager): Promise<Date | null> => {
        const hold =
          dto.action === 'ban'
            ? await this.openBanHold(manager, {
                targetUserId: userId,
                reportId: null,
                requestedBy: actorId,
                note: dto.note,
                reasonCode: dto.reasonCode,
                now,
              })
            : null;
        const persistedUntil = hold ? hold.expiresAt : suspendedUntil;

        await manager.update(
          User,
          { id: userId },
          {
            ...(preserveDeactivation ? {} : { status: UserStatus.Suspended }),
            suspendedUntil: persistedUntil,
          },
        );
        await this.syncDeactivationPreviousStatus(
          manager,
          userId,
          UserStatus.Suspended,
        );
        // Report-less audit row (reportId = null): this action answers to no
        // particular report. It surfaces in the global `GET /mod/audit` feed but
        // not `GET /mod/reports/audit`, which filters by report. A pending ban
        // is recorded as pending, carrying the hold's expiry, for the same
        // reason the report path records it that way: the trail must not say
        // someone was removed while a second moderator has yet to agree.
        await this.audit.writeAuditLog(
          null,
          actorId,
          hold ? BAN_PENDING_AUDIT_ACTION : dto.action,
          dto.reasonCode,
          dto.note,
          hold ? hold.expiresAt.toISOString() : dto.duration,
          manager,
        );
        return hold ? hold.expiresAt : null;
      },
    );

    // Ban evasion (TS-05), same contract as the report-driven path in
    // `ModerationService.actOnReport`: post-commit, best effort, and never able
    // to roll the ban back.
    //
    // SINCE TS-12 THIS CANNOT FIRE FROM HERE either: a `ban` opens a hold
    // rather than removing an account, so the emit belongs to
    // `BanRatificationService.decide`, at the instant a second moderator
    // confirms. The branch is kept so the move stays visible in this file
    // rather than reading as a deletion.
    if (dto.action === 'ban' && !holdExpiresAt) {
      const removed: AccountRemovedEvent = {
        userId,
        removalKind: RemovalKind.PlatformBan,
        communityId: null,
        removedAt: new Date(),
      };
      this.eventEmitter.emit(ACCOUNT_REMOVED, removed);
    }

    // A member who was already `Deactivated` keeps that status (only
    // `suspendedUntil` changes); everyone else becomes `Suspended`. Report the
    // status actually persisted, not a fixed literal — including the hold's
    // expiry for a ban awaiting ratification, which is genuinely when this
    // member's suspension currently ends.
    return {
      userId,
      suspendedUntil: holdExpiresAt ?? suspendedUntil,
      status: preserveDeactivation
        ? UserStatus.Deactivated
        : UserStatus.Suspended,
    };
  }

  /**
   * Clears a suspension and puts the member back in circulation.
   *
   * Mirrors `enforceAgainstUser`: a member who is currently `Deactivated` stays
   * that way. Lifting a suspension restores what they would have been without
   * it, and that is `Deactivated` for someone who had paused their own account
   * — un-hiding them here would be a privilege grant nobody asked for.
   */
  // Public since TS-12: `BanRatificationService.decide` calls it to undo the
  // interim suspension when a second moderator DECLINES a ban. Same
  // transaction-bearing contract as every other helper here.
  async restoreUser(manager: EntityManager, userId: string): Promise<void> {
    const user = await manager.findOne(User, { where: { id: userId } });
    const preserveDeactivation = user?.status === UserStatus.Deactivated;

    await manager.update(
      User,
      { id: userId },
      {
        ...(preserveDeactivation ? {} : { status: UserStatus.Active }),
        suspendedUntil: null,
      },
    );
    await this.syncDeactivationPreviousStatus(
      manager,
      userId,
      UserStatus.Active,
    );
  }

  /**
   * Keeps an open deactivation row's `previousStatus` in step with a
   * moderation decision.
   *
   * SECURITY: `AccountDeactivation.previousStatus` is what reactivation
   * restores to, and the account controller is deliberately JWT-only (no
   * `ActiveMemberGuard`) so a suspended member CAN reach
   * `POST /account/deactivate`. Without this, suspending an already-deactivated
   * member would leave `previousStatus = 'active'`, and signing back in would
   * launder the suspension away in one click — the exact attack that column was
   * added to prevent. The restore direction matters for the same reason in
   * reverse: a lifted suspension must not be re-applied on reactivation.
   */
  private async syncDeactivationPreviousStatus(
    manager: EntityManager,
    userId: string,
    status: UserStatus,
  ): Promise<void> {
    await manager.update(
      AccountDeactivation,
      { userId, reactivatedAt: IsNull() },
      { previousStatus: status },
    );
  }

  /**
   * `report.subjectId` → `users.id`, for member subjects.
   *
   * Subjects are addressed differently across domains, so a member may be
   * recorded by slug or by uuid (see `Report`'s entity doc). Shared with
   * `describeReported` so the read path and the enforcement path can never
   * disagree about who a report is actually about — a drift there would mean
   * suspending someone other than the person shown in the drawer.
   */
  async resolveReportedProfile(report: Report): Promise<Profile | null> {
    if (report.subjectType !== ReportSubjectType.Member) return null;
    const where = UUID_RE.test(report.subjectId)
      ? [{ slug: report.subjectId }, { userId: report.subjectId }]
      : [{ slug: report.subjectId }];
    return this.profiles.findOne({ where });
  }

  /**
   * The account a sanction should land on for THIS report: the reported member
   * on a `member` report, the author of the reported content on every other
   * subject type that has one.
   *
   * A `member` subject keeps going through `resolveReportedProfile` so the
   * enforcement path and the drawer's read path can never disagree about who a
   * report is about. Everything else goes through
   * {@link ReportSubjectResolverService}, which returns `null` rather than a
   * guess when the subject has no author (a `venue` report describing a place
   * in prose, an unclaimed directory listing, content whose author has erased
   * their account).
   */
  private async resolveEnforcementTargetUserId(
    report: Report,
  ): Promise<string | null> {
    if (report.subjectType === ReportSubjectType.Member) {
      const profile = await this.resolveReportedProfile(report);
      return profile?.userId ?? null;
    }
    const resolution = await this.subjectResolver.resolve(report);
    return resolution.authorUserId;
  }
}

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
import { LiftSuspensionDto } from './dto/lift-suspension.dto';
import { ModActionCode } from './dto/mod-action.dto';
import { ModAuditService } from './mod-audit.service';
import { parseDuration } from './parse-duration';

// Loose enough to guard `Repository.findOne({ where: { userId: subjectId } })`
// from a Postgres "invalid input syntax for type uuid" error when a
// non-member subjectId (a slug, a content id, ...) is checked against a
// `uuid` column.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    private readonly dataSource: DataSource,
    private readonly audit: ModAuditService,
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
   * Restores the member behind an overturned appeal's report, if there is one
   * and they are actually suspended.
   *
   * Silent when the appeal has no `reportId`, the report is not about a member,
   * or the member is not suspended — an overturn must still record its decision
   * in all of those cases rather than 400 on a bookkeeping detail.
   */
  async restoreSuspensionForAppeal(
    manager: EntityManager,
    reportId: string | null,
  ): Promise<void> {
    if (!reportId) return;

    const report = await manager.findOne(Report, { where: { id: reportId } });
    if (!report) return;

    const profile = await this.resolveReportedProfile(report);
    if (!profile) return;

    const user = await manager.findOne(User, {
      where: { id: profile.userId },
    });
    if (!user || user.status !== UserStatus.Suspended) return;

    await this.restoreUser(manager, user.id);
  }

  /**
   * Applies a moderator action to the reported *member*, if the action is one
   * that has an effect on an account.
   *
   * Returns the suspended user's id (so the caller can revoke their sessions
   * outside the transaction) alongside the suspension's expiry — `null` for a
   * permanent ban, a `Date` for a time-boxed suspension — so the caller can put
   * "suspended until X" in the outcome notification. Returns `null` when the
   * action was not an enforcement action.
   *
   * `restrict` is deliberately NOT handled here: there is no scoped-restriction
   * model in this codebase to write to. It continues to resolve the report and
   * write an audit row, and has NO enforcement effect. That is a known gap, not
   * an oversight — do not read its absence as "already handled".
   */
  async enforceAgainstUser(
    manager: EntityManager,
    report: Report,
    dto: { action: ModActionCode; duration?: string },
  ): Promise<{ userId: string; suspendedUntil: Date | null } | null> {
    if (dto.action !== 'suspend' && dto.action !== 'ban') {
      return null;
    }

    // Suspending the author of reported *content* is not possible here: the
    // author of a post/reply/message is not resolvable within this module (see
    // the note in `buildDetail`). Failing loudly beats the silent no-op this
    // whole change exists to remove.
    if (report.subjectType !== ReportSubjectType.Member) {
      throw new BadRequestException(
        `Cannot ${dto.action} for a "${report.subjectType}" report — that action applies to members only.`,
      );
    }

    const profile = await this.resolveReportedProfile(report);
    if (!profile) {
      throw new BadRequestException(
        'Could not resolve the reported member to an account.',
      );
    }
    const userId = profile.userId;

    const now = new Date();
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

    return { userId, suspendedUntil };
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
      throw new BadRequestException('A time-boxed restriction requires a duration.');
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

    await this.dataSource.transaction(async (manager) => {
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
      // Report-less audit row (reportId = null): this action answers to no
      // particular report. It surfaces in the global `GET /mod/audit` feed but
      // not `GET /mod/reports/audit`, which filters by report.
      await this.audit.writeAuditLog(
        null,
        actorId,
        dto.action,
        dto.reasonCode,
        dto.note,
        dto.duration,
        manager,
      );
    });

    // A member who was already `Deactivated` keeps that status (only
    // `suspendedUntil` changes); everyone else becomes `Suspended`. Report the
    // status actually persisted, not a fixed literal.
    return {
      userId,
      suspendedUntil,
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
  private async restoreUser(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
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
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthService } from '../auth/auth.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { AccountEnforcementService } from './account-enforcement.service';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import { ModAuditService } from './mod-audit.service';
import { LiftRestrictionDto } from './dto/lift-restriction.dto';
import { RestrictMemberDto } from './dto/restrict-member.dto';

/** `POST /admin/members/:id/verify` response — the fields the drawer re-reads. */
export interface VerifiedMemberDTO {
  id: string;
  slug: string;
  verified: boolean;
  verifiedAt: string | null;
}

/** `POST /admin/members/:id/restrict` response. */
export interface RestrictedMemberDTO {
  id: string;
  status: UserStatus;
  /** ISO expiry; `null` = permanent (a ban). */
  suspendedUntil: string | null;
}

/**
 * `GET`/`PATCH /admin/members/:id/restriction` response — the member's scoped
 * restriction (`users.restricted`), which is a different thing from the
 * suspension `RestrictedMemberDTO` above reports. A restriction leaves the
 * account `Active` and only gates the specific write paths `NotRestrictedGuard`
 * covers.
 */
export interface MemberRestrictionDTO {
  id: string;
  restricted: boolean;
  /** ISO expiry; `null` when there is no restriction in force. */
  restrictedUntil: string | null;
}

/** `POST /admin/members/:id/cite` response (ADM-9). */
export interface CitedMemberDTO {
  id: string;
  slug: string;
  note: string;
  citedAt: string;
}

/**
 * The admin member-drawer moderation actions — "Verify" and "Restrict" — that
 * had no backend before (P2-3). Lives in the moderation module because that is
 * where the machinery it reuses already sits: `AccountEnforcementService`
 * (the suspension model), `ModAuditService` (the immutable trail),
 * `NotificationsService` (the `moderation_outcome` message), and
 * `AuthService.revokeAllForUser` (killing live sessions). No new suspension
 * mechanism is invented — "Restrict" is a direct, report-less suspension/ban.
 */
@Injectable()
export class AdminMemberModerationService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(ModAuditLog)
    private readonly auditLogs: Repository<ModAuditLog>,
    private readonly enforcement: AccountEnforcementService,
    private readonly audit: ModAuditService,
    private readonly notifications: NotificationsService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Verify a member. Idempotent — verifying an already-verified member is a
   * no-op (matching this codebase's promotion/RSVP/vouch convention), not a
   * 409, and does not stamp a second `verified_at`/`verified_by`.
   */
  async verifyMember(
    actorId: string,
    memberId: string,
  ): Promise<VerifiedMemberDTO> {
    const profile = await this.profiles.findOne({
      where: { userId: memberId },
    });
    if (!profile) {
      throw new NotFoundException('Member not found.');
    }

    if (!profile.verified) {
      profile.verified = true;
      profile.verifiedAt = new Date();
      profile.verifiedBy = actorId;
      await this.profiles.save(profile);
      // Report-less audit row so the action is traceable in `GET /mod/audit`.
      await this.audit.writeAuditLog(null, actorId, 'member_verified');
    }

    return {
      id: profile.userId,
      slug: profile.slug,
      verified: profile.verified,
      verifiedAt: profile.verifiedAt?.toISOString() ?? null,
    };
  }

  /**
   * Cite evidence against a member (ADM-9) — a free-text note attached
   * directly to their audit trail from the trust network graph inspector's
   * "Cite" action. Report-less, like `member_verified`, but writes
   * `targetUserId`/`targetName` directly (bypassing `ModAuditService.
   * writeAuditLog`, which has no target-member parameter) — the same shape
   * `AdminMembersService.updateRole`/`grantStaffRole`/`revokeStaffRole` use
   * for their own report-less, member-directed rows, so this one resolves a
   * real subject in the global `GET /mod/audit` feed instead of falling back
   * to "Platform action", and surfaces in the member's own drawer timeline
   * (`AdminMembersService.detail`, which reads rows by `targetUserId`).
   */
  async citeMember(
    actorId: string,
    memberId: string,
    note: string,
  ): Promise<CitedMemberDTO> {
    const profile = await this.profiles.findOne({
      where: { userId: memberId },
    });
    if (!profile) {
      throw new NotFoundException('Member not found.');
    }

    const auditLog = await this.auditLogs.save(
      this.auditLogs.create({
        reportId: null,
        actorId,
        targetUserId: memberId,
        targetName: `${profile.firstName} ${profile.lastName}`.trim(),
        action: 'evidence_cited',
        reasonCode: null,
        note,
        duration: null,
      }),
    );

    return {
      id: profile.userId,
      slug: profile.slug,
      note: auditLog.note ?? note,
      citedAt: auditLog.createdAt.toISOString(),
    };
  }

  /**
   * Restrict a member platform-wide. A `duration` makes it a time-boxed
   * suspension; omitting it a permanent ban. Delegates the status transition +
   * audit row to `AccountEnforcementService.restrictMember` (the single owner of
   * the suspension model), then — outside that transaction — revokes the
   * member's live sessions so the restriction bites immediately, and notifies
   * them of the outcome and reason.
   */
  async restrictMember(
    actorId: string,
    memberId: string,
    dto: RestrictMemberDto,
  ): Promise<RestrictedMemberDTO> {
    const action = dto.duration ? 'suspend' : 'ban';
    const result = await this.enforcement.restrictMember(memberId, actorId, {
      action,
      duration: dto.duration,
      reasonCode: dto.reasonCode,
      note: dto.note,
    });

    // Kill live refresh tokens so the restricted member cannot mint fresh
    // access tokens — mirrors `ModerationService`'s post-enforcement step.
    await this.auth.revokeAllForUser(result.userId);

    await this.notifyOutcome(actorId, result, dto, action);

    return {
      id: result.userId,
      // Actual persisted status — a member who was already `Deactivated` keeps
      // that status while gaining the `suspendedUntil` restriction.
      status: result.status,
      suspendedUntil: result.suspendedUntil?.toISOString() ?? null,
    };
  }

  /**
   * The member's live scoped-restriction state, so the drawer knows whether
   * there is a restriction to offer a lift for. Read-only.
   */
  async restrictionState(memberId: string): Promise<MemberRestrictionDTO> {
    const state = await this.enforcement.restrictionState(memberId);
    return toMemberRestrictionDTO(state);
  }

  /**
   * Lift a member's scoped restriction — the way back out of a `restrict` that
   * did not exist before (TS-09). Delegates the state change + audit row to
   * `AccountEnforcementService.liftRestriction` (the single owner of the
   * restriction model), then tells the member, best-effort and post-commit.
   *
   * No session revocation, mirroring how applying a restriction does not revoke
   * either: a restriction is deliberately not a lockout, so neither direction
   * touches the member's devices.
   */
  async liftRestriction(
    actorId: string,
    memberId: string,
    dto: LiftRestrictionDto,
  ): Promise<MemberRestrictionDTO> {
    const before = await this.enforcement.restrictionState(memberId);
    const result = await this.enforcement.liftRestriction(
      memberId,
      actorId,
      dto,
    );

    // Idempotent lift: nothing changed, so nothing is announced. Telling a
    // member their restriction was lifted when they never had one would be a
    // notification about a decision that was not taken.
    if (before.restricted) {
      await this.notifyRestrictionLifted(actorId, memberId, dto);
    }

    return toMemberRestrictionDTO(result);
  }

  /**
   * Tell the member their restriction is over and why. Same channel and same
   * "the platform's word, not a member action" reasoning as
   * {@link notifyOutcome}: no actor is passed, so the block/mute filter and the
   * per-type preference gate are bypassed. Best-effort and post-commit.
   */
  private async notifyRestrictionLifted(
    actorId: string,
    memberId: string,
    dto: LiftRestrictionDto,
  ): Promise<void> {
    if (memberId === actorId) return;
    try {
      await this.notifications.create(
        memberId,
        NotificationType.ModerationOutcome,
        {
          source: 'moderation',
          action: 'restriction_lifted',
          reasonCode: dto.reasonCode,
          note: dto.note,
        },
      );
    } catch {
      // Intentionally ignored — the lift already committed.
    }
  }

  /**
   * Tell the restricted member the outcome and why. Best-effort and
   * post-commit: the restriction already committed and must not roll back on a
   * notification failure. No actor is passed to `notifications.create`, so this
   * bypasses the block/mute filter and the per-type preference gate — a
   * moderation outcome is the platform's word, exactly like
   * `ModerationService.notifyModerationOutcome`.
   */
  private async notifyOutcome(
    actorId: string,
    result: { userId: string; suspendedUntil: Date | null },
    dto: RestrictMemberDto,
    action: 'suspend' | 'ban',
  ): Promise<void> {
    if (result.userId === actorId) return;
    try {
      await this.notifications.create(
        result.userId,
        NotificationType.ModerationOutcome,
        {
          source: 'moderation',
          action,
          reasonCode: dto.reasonCode,
          note: dto.note,
          ...(result.suspendedUntil
            ? { expiresAt: result.suspendedUntil.toISOString() }
            : {}),
        },
      );
    } catch {
      // Intentionally ignored — the restriction already committed.
    }
  }
}

/** Entity-shaped restriction state to its wire DTO. Hand-mapped, like every
 *  other response in this module: there is no global serializer. */
function toMemberRestrictionDTO(state: {
  userId: string;
  restricted: boolean;
  restrictedUntil: Date | null;
}): MemberRestrictionDTO {
  return {
    id: state.userId,
    restricted: state.restricted,
    restrictedUntil: state.restrictedUntil?.toISOString() ?? null,
  };
}

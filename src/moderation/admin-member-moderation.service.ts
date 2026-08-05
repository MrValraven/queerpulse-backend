import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthService } from '../auth/auth.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { AccountEnforcementService } from './account-enforcement.service';
import { ModAuditService } from './mod-audit.service';
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

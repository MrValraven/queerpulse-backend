import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { AuthService } from './auth.service';

/** What `POST /auth/under-18-disclosure` answers with. */
export interface UnderAgeDisclosureResult {
  /** ISO timestamp of the disclosure on record (the FIRST one, if repeated). */
  disclosedAt: string;
  /** The member's status after the disclosure was applied. */
  status: UserStatus;
}

/**
 * Records a member's self-declaration that they are under 18, and puts the
 * account beyond reach of the community.
 *
 * Before this, the knowledge was simply discarded: the onboarding wizard showed
 * the under-18 notice and signed the person out, but the row stayed
 * `active`, so the next Google sign-in walked straight back into an adults-only
 * space. A notice is not an enforcement.
 *
 * It deliberately reuses the mechanisms that already exist rather than adding a
 * parallel lockout:
 *  - the same suspension shape `AccountEnforcementService` writes — `status =
 *    Suspended` with `suspendedUntil = null`, i.e. permanent, never
 *    self-expiring (there is no date of birth to count down from; coming back
 *    at 18 goes through the contact link on the notice, not a timer);
 *  - the same `AccountDeactivation.previousStatus` sync, so an already-paused
 *    member cannot launder the suspension away by reactivating
 *    (`syncDeactivationPreviousStatus`'s SECURITY note);
 *  - `AuthService.revokeAllForUser`, which kills every live refresh token AND
 *    emits `USER_SESSION_REVOKED` so the chat gateway drops their open sockets.
 *    The member must not be left holding a live session into an 18+ space
 *    while the frontend is still animating the notice.
 *
 * It lives in `src/auth` rather than with the moderation services because
 * `ModerationModule` imports `AuthModule`; injecting `AccountEnforcementService`
 * here would close that cycle. The overlap is three lines of shared shape, kept
 * honest by the doc comments on both sides.
 */
@Injectable()
export class UnderAgeDisclosureService {
  private readonly logger = new Logger(UnderAgeDisclosureService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly authService: AuthService,
  ) {}

  /**
   * Stamp the disclosure, suspend the account, and revoke every live session.
   *
   * Idempotent, matching this codebase's convention for repeated
   * promotion/RSVP/vouch/accept calls: a second disclosure keeps the FIRST
   * timestamp (the record of when they told us, which never changes) and
   * re-runs the session revoke, since the point of the second call is almost
   * always a client retrying after a failure.
   *
   * A member who had already deactivated keeps `Deactivated` as their live
   * status — the same carve-out `enforceAgainstUser` makes — with
   * `previousStatus` synced to `Suspended` so signing back in cannot undo this.
   */
  async record(userId: string): Promise<UnderAgeDisclosureResult> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Member not found');
    }

    const preserveDeactivation = user.status === UserStatus.Deactivated;
    const disclosedAt = user.underAgeDisclosedAt ?? new Date();
    const status = preserveDeactivation
      ? UserStatus.Deactivated
      : UserStatus.Suspended;

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        User,
        { id: userId },
        {
          underAgeDisclosedAt: disclosedAt,
          ...(preserveDeactivation ? {} : { status: UserStatus.Suspended }),
          // NULL = permanent. Never a duration: see this class's doc comment.
          suspendedUntil: null,
        },
      );
      await manager.update(
        AccountDeactivation,
        { userId, reactivatedAt: IsNull() },
        { previousStatus: UserStatus.Suspended },
      );
    });

    // Outside the transaction, exactly like `ModerationService`'s enforcement
    // path: revoking sessions emits `USER_SESSION_REVOKED`, and an event
    // emitted inside a transaction can be consumed before that transaction
    // commits.
    await this.authService.revokeAllForUser(userId);

    // No email, no name — just that a disclosure was recorded, so the operator
    // can see the path is live without the log becoming a register of minors.
    this.logger.warn(`Under-18 disclosure recorded: userId=${userId}`);

    return { disclosedAt: disclosedAt.toISOString(), status };
  }
}

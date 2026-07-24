import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { USER_PROMOTED, UserPromotedEvent } from '../users/user.events';
import {
  USER_SESSION_REVOKED,
  UserSessionRevokedEvent,
} from '../chat/session.events';
import { InvitesService } from '../membership/invites.service';
import { VouchService } from '../vouch/vouch.service';
import { VOUCH_CREATED, VouchCreatedEvent } from '../vouch/vouch.events';
import { ConnectionsService } from '../connections/connections.service';
import {
  EmailSuppression,
  hashSuppressedEmail,
} from '../account/entities/email-suppression.entity';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import {
  DeletionRequest,
  DeletionRequestStatus,
} from '../account/entities/deletion-request.entity';
import { SignupRejectedError } from './errors/signup-rejected.error';
import { RefreshToken } from './entities/refresh-token.entity';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

export interface GoogleUserInput {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    private readonly dataSource: DataSource,
    private readonly invitesService: InvitesService,
    private readonly vouchService: VouchService,
    private readonly connectionsService: ConnectionsService,
    private readonly eventEmitter: EventEmitter2,
    @InjectRepository(EmailSuppression)
    private readonly emailSuppressions: Repository<EmailSuppression>,
    // Both read-only here, for the reactivate-on-sign-in path. Registered as
    // repositories for the same reason `EmailSuppression` is (see above):
    // injecting `AccountService` would create an AuthModule <-> AccountModule
    // cycle, since AccountModule already depends on AuthModule's entities.
    @InjectRepository(AccountDeactivation)
    private readonly deactivations: Repository<AccountDeactivation>,
    @InjectRepository(DeletionRequest)
    private readonly deletionRequests: Repository<DeletionRequest>,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  // The suppression list is a plain lookup table with no service of its own,
  // and `AccountModule` already imports `AuthModule`'s entity the same way —
  // so this reads the repository directly rather than creating a module cycle
  // by injecting an account-module service here.
  private async isEmailSuppressed(email: string): Promise<boolean> {
    const hit = await this.emailSuppressions.findOne({
      where: { emailHash: hashSuppressedEmail(email) },
    });
    return hit !== null;
  }

  async validateOrCreateGoogleUser(
    profile: GoogleUserInput,
    inviteCode?: string,
    attestation?: { ageAttested?: boolean; termsVersion?: string },
  ): Promise<User> {
    const existing = await this.usersService.findByGoogleId(profile.googleId);
    if (existing) {
      // Returning member — invite not required. May also be coming back from a
      // deactivation, which signing in is the documented way to undo.
      return this.reactivateIfDeactivated(existing);
    }
    // Registration kill switch. Placed first among the new-account checks so a
    // closed platform reports itself as closed, rather than telling applicants
    // they need an invite that could not be redeemed right now anyway. The
    // `existing` return above means this never affects a member who already
    // has an account.
    //
    // A LOCKDOWN CLOSES THIS PATH TOO. `AuthController` is `@LockdownExempt()`
    // — correctly, since an admin has to be able to authenticate in order to
    // lift a lockdown — so `PlatformLockdownGuard` never sees this request, and
    // without the check here anyone holding a valid invite would still create a
    // `User` row on a fully locked platform. Lockdown implies no signups.
    //
    // Both conditions reuse the `registration_disabled` reason rather than
    // inventing a lockdown-specific one: the frontend already handles it, and
    // the applicant's situation is identical either way — signups are closed,
    // try later. It must stay AFTER the `existing` short-circuit above, or an
    // admin enabling lockdown would lock themselves out of signing back in.
    const settings = await this.platformSettings.get();
    if (!settings.registrationEnabled || settings.lockdownEnabled) {
      throw new SignupRejectedError('registration_disabled');
    }
    if (!inviteCode) {
      throw new SignupRejectedError('invite_required');
    }
    // Erasure suppression list. Checked on the NEW-account path only: the
    // `existing` short-circuit above already returned, so a member who still
    // has an account is never affected. Without this, a member who exercised
    // their right to erasure and then signed in with the same Google account
    // would silently get a brand-new account — exactly the "accidentally
    // re-create your account" outcome the delete-account UI promises against.
    if (await this.isEmailSuppressed(profile.email)) {
      throw new SignupRejectedError('account_suppressed');
    }
    // 18+ gate (Terms §eligibility). New accounts only: existing members
    // predate the gate and must not be locked out of their own accounts.
    if (!attestation?.ageAttested) {
      throw new SignupRejectedError('age_attestation_required');
    }
    const attestedAt = new Date();

    const { user, vouched, inviterId } = await this.dataSource.transaction(
      async (manager) => {
        const { inviteId, inviterId, personal, vouch } =
          await this.invitesService.validateInviteForSignup(
            manager,
            inviteCode,
            profile.email,
          );
        const created = await this.usersService.createGoogleUser(manager, {
          googleId: profile.googleId,
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          avatarUrl: profile.avatarUrl ?? null,
          status: UserStatus.Active,
          invitedBy: inviterId,
          ageAttestedAt: attestedAt,
          termsVersion: attestation.termsVersion ?? null,
        });
        await this.invitesService.claimInvite(manager, inviteId, created.id);
        // The inviter vouches for the member they personally brought in — the
        // real endorsement edge behind the "X vouched for you" card the new
        // member sees during onboarding, carrying over the invite's vouch note.
        // Only for personal invites: an admin approving a join request (or the
        // genesis bootstrap) is not a personal endorsement. Part of this
        // transaction so a failed signup never leaves a dangling vouch.
        const vouched =
          personal &&
          (await this.vouchService.createVouchInTransaction(
            manager,
            inviterId,
            created.id,
            vouch,
          ));
        // The inviter and the member they personally brought in become mutually
        // connected the moment the account exists — no request, no acceptance
        // step. Silent (no CONNECTION_ACCEPTED): this is an implicit link, not a
        // user action, and an event fired here would survive a rollback of this
        // transaction. Personal invites only, matching the auto-vouch: an admin
        // approving a join request (or the genesis bootstrap) is not a personal
        // connection. Part of this transaction so a failed signup never leaves a
        // dangling connection.
        if (personal) {
          await this.connectionsService.createConnectionInTransaction(
            manager,
            inviterId,
            created.id,
          );
        }
        return { user: created, vouched, inviterId };
      },
    );

    // Parity with the accept flow: the new member gets the "PromotedToMember"
    // notification via the existing USER_PROMOTED listener.
    this.eventEmitter.emit(USER_PROMOTED, {
      userId: user.id,
    } satisfies UserPromotedEvent);

    // Emitted only after the transaction commits (a mid-transaction emit would
    // survive a rollback): fans out the "VouchReceived" notification and keeps
    // vouch counts consistent, exactly as a normal vouch does.
    if (vouched) {
      this.eventEmitter.emit(VOUCH_CREATED, {
        voucherId: inviterId,
        voucheeId: user.id,
      } satisfies VouchCreatedEvent);
    }

    return user;
  }

  /**
   * "Reactivate by signing back in with Google" — the promise the deactivation
   * UI makes. Undoes a member-initiated pause on the returning-member path.
   *
   * 🔴 The critical distinction this method enforces: **a member in the 30-day
   * deletion grace period is NOT reactivated by signing in.** Both states share
   * `users.status = Deactivated`, but they mean opposite things. Deactivation
   * is "pause me, let me back whenever"; a deletion request is a standing
   * instruction to erase everything, revocable only by an explicit, deliberate
   * `DELETE /account/deletion-request` (reachable precisely because the account
   * controller has no `ActiveMemberGuard`). Silently cancelling an erasure
   * because someone opened the app once would be very wrong — and it is a
   * realistic accident, since signing in is exactly how a member checks how
   * many days they have left.
   *
   * So an open grace/processing request wins over an open deactivation row,
   * including in the both-rows case (deactivated first, then asked to be
   * erased). Such a member stays hidden and stays scheduled for erasure; they
   * come back by cancelling the deletion, and `cancelDeletionRequest` then
   * leaves them deactivated if that is what they separately asked for.
   */
  private async reactivateIfDeactivated(user: User): Promise<User> {
    if (user.status !== UserStatus.Deactivated) {
      return user;
    }

    // Erasure pending → hands off. Note `Processing` too: the sweep has already
    // claimed the row and is mid-erasure, which is even less reversible.
    const pendingDeletion = await this.deletionRequests.findOne({
      where: [
        { userId: user.id, status: DeletionRequestStatus.Grace },
        { userId: user.id, status: DeletionRequestStatus.Processing },
      ],
    });
    if (pendingDeletion) {
      return user;
    }

    const open = await this.deactivations.findOne({
      where: { userId: user.id, reactivatedAt: IsNull() },
    });
    if (!open) {
      // `Deactivated` with no open ledger row: we have no recorded status to
      // restore and no evidence the member asked for this. Guessing `Active`
      // here would be a privilege grant, so leave it for a human.
      this.logger.warn(
        `User ${user.id} is deactivated with no open deactivation row; not auto-reactivating`,
      );
      return user;
    }

    // Restore what they had — NOT a hardcoded `Active`. A suspended member who
    // deactivated comes back suspended; deactivation is not a way to launder a
    // moderation action.
    const restored = open.previousStatus ?? UserStatus.Active;
    await this.dataSource.transaction(async (manager) => {
      // Conditional claim on both writes (the `invites.service` idiom): two
      // concurrent sign-ins reactivate exactly once.
      await manager.update(
        AccountDeactivation,
        { id: open.id, reactivatedAt: IsNull() },
        { reactivatedAt: new Date() },
      );
      await manager.update(
        User,
        { id: user.id, status: UserStatus.Deactivated },
        { status: restored },
      );
    });
    this.logger.log(`Reactivated user ${user.id} on sign-in (-> ${restored})`);

    // Keep the in-memory entity consistent — the caller mints an access token
    // from it, and a stale `deactivated` claim would put the member straight
    // back into a 403 on their first request.
    user.status = restored;
    return user;
  }

  async issueTokens(user: User, userAgent?: string): Promise<TokenPair> {
    const { accessToken, refreshToken } = await this.issueTokensWithRow(
      user,
      userAgent,
    );
    return { accessToken, refreshToken };
  }

  async rotateRefreshToken(
    rawRefreshToken: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    // 1. Signature/expiry check (throws -> 401).
    try {
      await this.jwtService.verifyAsync(rawRefreshToken, {
        secret: this.configService.getOrThrow<string>('auth.jwtRefreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // 2. Allowlist lookup by sha-256 hash.
    const tokenHash = this.hashToken(rawRefreshToken);
    const row = await this.refreshTokens.findOne({ where: { tokenHash } });
    if (!row) {
      throw new UnauthorizedException('Unknown refresh token');
    }

    // 3. Reuse detection: an already-revoked token presented again = theft.
    if (row.revokedAt) {
      await this.revokeFamily(row.userId, 'reuse-detected', {
        rowId: row.id,
        userAgent,
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Expired refresh token');
    }

    // 4. Load the user fresh (current status/role) before minting a new pair.
    //    `findByIdWithEmail`, not `findById`: the new access token embeds an
    //    email claim, and email is `select: false` (see User.email).
    const user = await this.usersService.findByIdWithEmail(row.userId);
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    // 5. Rotate atomically. The old row's revoke and the new row's insert are a
    //    SINGLE transaction, so there is never a window with two live tokens.
    //    The revoke is a CONDITIONAL claim (`revoked_at IS NULL`, mirroring the
    //    invites.service pattern): if two refresh requests race on the same
    //    token, exactly one wins the claim — the loser sees `affected === 0` and
    //    is treated as reuse (its whole family is revoked).
    const newRowId = randomUUID();
    const outcome = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(RefreshToken);
      const claim = await repo.update(
        { id: row.id, revokedAt: IsNull() },
        { revokedAt: new Date(), replacedBy: newRowId },
      );
      if (claim.affected === 0) {
        // Lost the race (concurrent rotation/reuse). Write nothing here — the
        // transaction commits as a no-op and we revoke the family outside it so
        // that revocation survives instead of being rolled back.
        return { reuse: true as const };
      }
      const tokens = await this.issueTokensWithRow(
        user,
        userAgent,
        newRowId,
        manager,
      );
      return {
        reuse: false as const,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    });

    if (outcome.reuse) {
      await this.revokeFamily(row.userId, 'reuse-detected', {
        rowId: row.id,
        userAgent,
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    return {
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken,
    };
  }

  async revokeRefreshToken(rawRefreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawRefreshToken);
    // Look the row up first so we know whose live sockets to drop. A missing or
    // already-revoked token is a no-op (logout is best-effort).
    const row = await this.refreshTokens.findOne({ where: { tokenHash } });
    if (!row || row.revokedAt) {
      return;
    }
    await this.refreshTokens.update(
      { id: row.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    // Never log the token itself — only that a revocation happened.
    this.logger.log('Revoked 1 refresh token on logout');
    // Force-disconnect this member's live WebSocket sockets — an open socket
    // otherwise outlives logout (the chat gateway consumes this event).
    this.eventEmitter.emit(USER_SESSION_REVOKED, {
      userId: row.userId,
    } satisfies UserSessionRevokedEvent);
  }

  /** Revoke every live refresh token for a user (logout-all / global sign-out). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.revokeFamily(userId, 'logout-all');
  }

  // --- internals ---

  /**
   * Revoke all of a user's currently-live refresh tokens in one statement and
   * emit a security log line. Used for both explicit logout-all and reuse
   * detection. Logs never include token values/secrets.
   */
  private async revokeFamily(
    userId: string,
    reason: 'reuse-detected' | 'logout-all',
    context: { rowId?: string; userAgent?: string } = {},
  ): Promise<void> {
    const result = await this.refreshTokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    this.logger.warn(
      `Refresh token family revoked: reason=${reason} userId=${userId} ` +
        `rowId=${context.rowId ?? 'n/a'} userAgent=${context.userAgent ?? 'n/a'} ` +
        `count=${result.affected ?? 0}`,
    );
    // Drop the member's live sockets too. Covers both logout-all and reuse
    // detection (a compromise signal) — the chat gateway consumes this event.
    this.eventEmitter.emit(USER_SESSION_REVOKED, {
      userId,
    } satisfies UserSessionRevokedEvent);
  }

  private async persistRefreshToken(
    userId: string,
    refreshToken: string,
    userAgent?: string,
    id?: string,
    manager?: EntityManager,
  ): Promise<RefreshToken> {
    const repo = manager
      ? manager.getRepository(RefreshToken)
      : this.refreshTokens;
    const decoded = this.jwtService.decode(refreshToken);
    const row = repo.create({
      // A pre-generated id lets the rotation claim reference `replaced_by`
      // before the new row is inserted, keeping both writes in one transaction.
      ...(id ? { id } : {}),
      userId,
      tokenHash: this.hashToken(refreshToken),
      expiresAt: new Date(decoded.exp * 1000),
      userAgent: userAgent ?? null,
    });
    return repo.save(row);
  }

  // Issue tokens AND return the persisted refresh-row id (for replaced_by linkage).
  private async issueTokensWithRow(
    user: User,
    userAgent?: string,
    rowId?: string,
    manager?: EntityManager,
  ): Promise<TokenPair & { rowId: string }> {
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, email: user.email, status: user.status, role: user.role },
      {
        secret: this.configService.getOrThrow<string>('auth.jwtAccessSecret'),
        expiresIn: this.configService.get<string>(
          'auth.jwtAccessTtl',
          '15m',
        ) as JwtSignOptions['expiresIn'],
      },
    );
    const refreshToken = await this.jwtService.signAsync(
      // jti guarantees every refresh token is unique even when two are minted
      // for the same user within the same second — otherwise identical payloads
      // would produce identical sha-256 hashes and an ambiguous allowlist lookup.
      { sub: user.id, jti: randomUUID() },
      {
        secret: this.configService.getOrThrow<string>('auth.jwtRefreshSecret'),
        expiresIn: this.configService.get<string>(
          'auth.jwtRefreshTtl',
          '30d',
        ) as JwtSignOptions['expiresIn'],
      },
    );
    const row = await this.persistRefreshToken(
      user.id,
      refreshToken,
      userAgent,
      rowId,
      manager,
    );
    return { accessToken, refreshToken, rowId: row.id };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { ReauthResult } from '../account/account-response';
import { isUniqueViolation } from '../common/db-errors';
import { REAUTH_TTL_MS } from '../account/account.constants';
import { AccountReauthToken } from '../account/entities/account-reauth-token.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { UsersService } from '../users/users.service';
import { CURRENT_TERMS_VERSION } from '../consent/policy-versions';
import { USER_PROMOTED, UserPromotedEvent } from '../users/user.events';
import {
  INVITE_ACCEPTED,
  InviteAcceptedEvent,
} from '../membership/membership.events';
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
import { deviceLabelFromUserAgent } from './device-label';
import {
  SECURITY_NEW_SIGN_IN,
  SecurityNewSignInEvent,
} from './security.events';
import {
  SESSION_REFRESHED,
  SessionRefreshedEvent,
} from './session-activity.events';
import {
  DEFAULT_LOGIN_ALERTS_ENABLED,
  MemberPreferences,
} from '../preferences/entities/member-preferences.entity';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import { AccessTokenPayload } from './strategies/jwt.strategy';

/** The suspension detail `GET /auth/me` surfaces to a locked-out member. */
export interface SuspensionInfo {
  /** ISO expiry for a timed suspension; `null` while Suspended = permanent ban. */
  suspendedUntil: string | null;
  /** The moderator's reason, or `null` when none is on record. */
  suspension: { note: string; reasonCode: string } | null;
}

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

/**
 * The identity of a SESSION, as opposed to the token that currently represents
 * it. Minted once at sign-in and carried unchanged through every rotation, so
 * `refresh_tokens` rows descended from one sign-in stay recognisable as one
 * device (see `RefreshToken.familyId`).
 */
interface SessionIdentity {
  familyId: string;
  sessionStartedAt: Date;
}

/**
 * What the refresh-token history says about the device presenting a sign-in.
 *
 * Two booleans rather than one because "I do not recognise this device" and "I
 * have nothing to recognise it against" are different answers, and only the
 * first is worth waking somebody up for. See `AuthService.recogniseDevice`.
 */
interface DeviceRecognition {
  /** At least one earlier row for this member carries a device label. */
  hasDeviceHistory: boolean;
  /** An earlier row carries this exact label. */
  isKnownDevice: boolean;
}

/**
 * How long after a refresh token is rotated its PARENT is still accepted.
 *
 * Rotation is a conditional claim on `revoked_at IS NULL`, and the loser used
 * to be treated as theft: the whole family revoked, every session dropped, a
 * `warn` line indistinguishable from a real compromise. Two of the member's own
 * clients refreshing the same expiring cookie within the same instant (a tab
 * plus the installed PWA, a tab in a browser without the Web Locks API the
 * frontend's cross-tab lock relies on) hit that deterministically and were
 * signed out everywhere. Inside this window the presenting client is handed a
 * fresh pair instead; outside it, reuse detection is unchanged.
 *
 * Kept short on purpose: it is the width of the window in which a stolen
 * refresh token could be replayed alongside the legitimate one without
 * tripping detection.
 */
const REFRESH_ROTATION_GRACE_MS = 10_000;

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
    // Read-only, and for exactly one column: `login_alerts_enabled`, consulted
    // before a new-device sign-in alert is emitted. Registered as a repository
    // rather than injecting `PreferencesService` for the reason the entities
    // above are — `PreferencesModule` would be a new edge out of AuthModule,
    // which most of the platform already imports.
    @InjectRepository(MemberPreferences)
    private readonly memberPreferences: Repository<MemberPreferences>,
    // Read-side only (registered on AuthModule, not via NotificationsModule) —
    // reads the member's latest moderation-outcome reason for `suspensionInfoFor`.
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    // Read-side only, same pattern — reads the caller's additive staff-role
    // grants for `staffRolesFor` (surfaced on `GET /auth/me`).
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
    // Write-side this time (same cross-module registration pattern as the
    // repositories above) — `mintReauthToken` writes the row the step-up
    // reauth OAuth round trip (`AuthController.googleCallback`'s `reauth`
    // branch) produces; `AccountService.assertReauth` is still what reads it
    // back to gate a destructive/export action.
    @InjectRepository(AccountReauthToken)
    private readonly reauthTokens: Repository<AccountReauthToken>,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  /**
   * The suspension detail surfaced on `GET /auth/me` so a locked-out member can
   * see WHY on the account-suspended / account-banned page — they can't reach a
   * gated endpoint, so the reason has to ride on `me`.
   *
   * The reason text comes from the member's latest `moderation_outcome`
   * notification: the one store that already ties the moderator's note +
   * reasonCode to this user (the mod audit log is keyed to the report, not the
   * member). Returns nulls for a member who isn't suspended, and a null
   * `suspension` when no such notification exists (a suspension predating that
   * feature) — the page then falls back to its generic copy.
   */
  async suspensionInfoFor(user: User): Promise<SuspensionInfo> {
    if (user.status !== UserStatus.Suspended) {
      return { suspendedUntil: null, suspension: null };
    }
    const latest = await this.notifications.findOne({
      where: { userId: user.id, type: NotificationType.ModerationOutcome },
      order: { createdAt: 'DESC' },
    });
    const payload = (latest?.payload ?? {}) as {
      note?: unknown;
      reasonCode?: unknown;
    };
    const hasReason =
      typeof payload.note === 'string' ||
      typeof payload.reasonCode === 'string';
    return {
      // NULL while Suspended = a permanent ban; the frontend reads that to show
      // the banned page rather than the timed-suspension one.
      suspendedUntil: user.suspendedUntil
        ? user.suspendedUntil.toISOString()
        : null,
      suspension: hasReason
        ? {
            note: typeof payload.note === 'string' ? payload.note : '',
            reasonCode:
              typeof payload.reasonCode === 'string' ? payload.reasonCode : '',
          }
        : null,
    };
  }

  /**
   * The caller's additive "staff role" grants (`STAFF_ROLES`), surfaced on
   * `GET /auth/me` so the frontend capability layer (`useMyStaffRoles`) has
   * them without a second fetch. One indexed query by `userId`; empty array
   * for a member holding none — admin superset logic lives on the frontend
   * hook (mirroring `StaffRolesGuard`), not here.
   */
  async staffRolesFor(userId: string): Promise<string[]> {
    const grants = await this.staffRoles.find({
      where: { userId },
      select: ['role'],
    });
    return grants.map((grant) => grant.role);
  }

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
    // The `googleId` lookup above can miss while the EMAIL is already taken —
    // a re-created Google Workspace account presenting a new subject for the
    // same verified address, a seeded fixture, the HOUSE_EMAIL collision
    // genesis.constants.ts documents. Left to the insert, `users.email`'s
    // unique constraint threw a QueryFailedError that nothing on this path
    // maps, so the browser (mid-OAuth redirect, so no SPA to catch it) landed
    // on a raw `{"statusCode":500}` body. Reject it as a signup rejection
    // instead, which redirects to the sign-in page. The race that slips past
    // this check is caught at the insert below.
    if (await this.usersService.existsByEmail(profile.email)) {
      throw new SignupRejectedError('email_in_use');
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
        let created: User;
        try {
          created = await this.usersService.createGoogleUser(manager, {
            googleId: profile.googleId,
            email: profile.email,
            firstName: profile.firstName,
            lastName: profile.lastName,
            avatarUrl: profile.avatarUrl ?? null,
            status: UserStatus.Active,
            invitedBy: inviterId,
            ageAttestedAt: attestedAt,
            // The revision the client actually showed them wins; the
            // server's own current revision is the fallback so a signup can
            // never land with a NULL Terms version just because the OAuth
            // state lost the query param (ID-14).
            termsVersion: attestation.termsVersion ?? CURRENT_TERMS_VERSION,
          });
        } catch (err) {
          // Backstop for the check above losing a race. `createGoogleUser`
          // already absorbs slug/handle collisions internally (savepoint +
          // retry), so a 23505 escaping to here is an identity collision on
          // `users.email` / `users.google_id`. Either way a redirect to the
          // sign-in page beats a raw 500 the member cannot act on.
          if (isUniqueViolation(err)) {
            throw new SignupRejectedError('email_in_use');
          }
          throw err;
        }
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

    // Tell the inviter their invite was redeemed. `inviterId` is always a real
    // member (invites.inviter_id is NOT NULL), and never the new member, so no
    // self-notification is possible. Best-effort, post-commit, on the same bus.
    this.eventEmitter.emit(INVITE_ACCEPTED, {
      inviterId,
      newMemberId: user.id,
    } satisfies InviteAcceptedEvent);

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

  /**
   * Mint a pair for a BRAND-NEW session (a sign-in), starting a fresh family.
   *
   * Callers holding an existing refresh cookie for the same browser should run
   * `revokeSessionForToken` first: signing in again overwrites that cookie, so
   * the session it named becomes unreachable and would otherwise sit in the
   * member's device list, live, until it expired 30 days later.
   */
  async issueTokens(user: User, userAgent?: string): Promise<TokenPair> {
    const session: SessionIdentity = {
      familyId: randomUUID(),
      sessionStartedAt: new Date(),
    };
    const deviceLabel = deviceLabelFromUserAgent(userAgent);
    // Asked BEFORE the new row is written, or the row we are about to write
    // would itself count as prior history and every device would look familiar.
    const recognition = await this.recogniseDevice(user.id, deviceLabel);
    const { accessToken, refreshToken } = await this.issueTokensWithRow(
      user,
      session,
      userAgent,
    );
    await this.announceNewDeviceSignIn(
      user.id,
      recognition,
      deviceLabel,
      session,
    );
    return { accessToken, refreshToken };
  }

  /**
   * Does this member's refresh-token history already contain this device?
   *
   * Deliberately reads EVERY row for the member, revoked and expired included:
   * signing out and back in on the same laptop is not a new device, and
   * `AuthController.googleCallback` revokes this browser's previous session a
   * moment before minting the new one, so the row that proves the device is
   * familiar is usually one that was revoked seconds ago.
   *
   * One caveat, stated rather than hidden: `AuthMaintenanceService` purges rows
   * one refresh lifetime after they die, so a device left unused for months
   * eventually falls out of history and reads as new. Being told about a
   * long-dormant device signing in is a reasonable thing to be told about.
   */
  private async recogniseDevice(
    userId: string,
    deviceLabel: string,
  ): Promise<DeviceRecognition> {
    const rows = await this.refreshTokens
      .createQueryBuilder('token')
      .select('token.deviceLabel', 'deviceLabel')
      .distinct(true)
      .where('token.userId = :userId', { userId })
      .getRawMany<{ deviceLabel: string | null }>();
    const knownLabels = rows
      .map((row) => row.deviceLabel)
      .filter((label): label is string => typeof label === 'string');
    return {
      // Rows written before `device_label` existed carry NULL. A member whose
      // whole history predates the column has no device history we can compare
      // against, and alerting them about their own everyday laptop the first
      // time they sign in after the deploy would teach exactly the wrong
      // reflex. They get no alert until the first labelled row exists, which is
      // the sign-in happening right now.
      hasDeviceHistory: knownLabels.length > 0,
      isKnownDevice: knownLabels.includes(deviceLabel),
    };
  }

  /**
   * Tell the member their account was just signed in to from a device they have
   * not used before.
   *
   * BEST-EFFORT AND SILENT ON FAILURE. This runs inside the sign-in request,
   * and nothing here may stop somebody logging in: a preferences read that
   * times out must cost a notification, never a session.
   *
   * The event carries a coarse device label and a timestamp, and nothing else.
   * `NotificationsListener` turns it into the bell row; the payload is
   * deliberately thin enough that its push preview cannot out anyone.
   */
  private async announceNewDeviceSignIn(
    userId: string,
    recognition: DeviceRecognition,
    deviceLabel: string,
    session: SessionIdentity,
  ): Promise<void> {
    try {
      if (recognition.isKnownDevice || !recognition.hasDeviceHistory) {
        return;
      }
      if (!(await this.loginAlertsEnabled(userId))) {
        return;
      }
      this.eventEmitter.emit(SECURITY_NEW_SIGN_IN, {
        userId,
        deviceLabel,
        signedInAt: session.sessionStartedAt,
        familyId: session.familyId,
      } satisfies SecurityNewSignInEvent);
      this.logger.log(
        `New-device sign-in alert emitted: userId=${userId} familyId=${session.familyId}`,
      );
    } catch (error) {
      this.logger.warn(
        `New-device sign-in alert failed for userId=${userId}: ${String(error)}`,
      );
    }
  }

  /** The member's own switch, defaulting ON when they have no preferences row. */
  private async loginAlertsEnabled(userId: string): Promise<boolean> {
    const row = await this.memberPreferences.findOne({
      where: { userId },
      select: { userId: true, loginAlertsEnabled: true },
    });
    return row?.loginAlertsEnabled ?? DEFAULT_LOGIN_ALERTS_ENABLED;
  }

  /**
   * Revoke the session a raw refresh token belongs to, whoever it belongs to.
   *
   * Called from the sign-in path with the cookie the browser is ABOUT to have
   * overwritten. Silently does nothing when the cookie is missing, unknown or
   * already dead, because a first-ever sign-in is the common case and a failure
   * here must never block a login.
   *
   * Deliberately does NOT emit `USER_SESSION_REVOKED`. That event drops every
   * socket the MEMBER has open, on every device, and here the only session
   * ending is the one on the browser that is signing in again with a fresh
   * cookie in the same response. Firing it would kick the member's phone off
   * chat every time they signed in on their laptop.
   */
  async revokeSessionForToken(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken) return;
    const row = await this.refreshTokens.findOne({
      where: { tokenHash: this.hashToken(rawRefreshToken) },
    });
    if (!row) return;
    const result = await this.refreshTokens.update(
      { familyId: row.familyId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    if (result.affected) {
      this.logger.log(
        `Replaced the session on this device at sign-in: userId=${row.userId} familyId=${row.familyId} rows=${result.affected}`,
      );
    }
  }

  /**
   * Verifies + decodes an access token, returning `null` (never throwing) on
   * any failure — missing, malformed, expired, wrong secret. Used only by
   * `AuthController.googleCallback`'s reauth branch to read who the CALLER
   * was before the step-up round trip, from the same `access_token` cookie
   * `JwtStrategy` reads on every other request. Deliberately does NOT re-read
   * status/role from the DB the way `JwtStrategy.validate` does — the caller
   * only needs `sub` (to mint the reauth token against) and the shape check
   * doubles as cheap defense against a token minted for a different purpose
   * (e.g. a refresh token, which carries no `email`/`status`/`role`).
   */
  /**
   * Verify an access token's signature/expiry and claim shape.
   *
   * The returned `status` and `role` are ADVISORY snapshots taken at mint time
   * (see {@link AccessTokenPayload}); the only caller, the reauth branch of
   * `AuthController.googleCallback`, reads `sub` alone and re-resolves the
   * account from the database. Do not start authorising on the other claims.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(
        token,
        {
          secret: this.configService.getOrThrow<string>('auth.jwtAccessSecret'),
          // Pin the algorithm to the one we sign with (HS256). Without an
          // allowlist the verifier accepts any algorithm the token's header
          // names, which is the shape of the classic JWT algorithm-confusion
          // bug — defence in depth even though our secret is a symmetric string.
          algorithms: ['HS256'],
        },
      );
      if (
        !payload?.sub ||
        !payload?.email ||
        !payload?.status ||
        !payload?.role
      ) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Mints a short-lived, single-purpose token proving `userId` just completed
   * a step-up re-authentication — the OAuth round trip in
   * `AuthController.googleCallback`'s `reauth` branch, which forces
   * `prompt=login` and verifies the returned Google account matches this same
   * user before ever calling this. `AccountService.assertReauth` is the only
   * reader; `AccountRetentionService` sweeps expired rows. Mirrors what
   * `AccountService.reauth` used to do directly (with no actual
   * re-authentication behind it) — this is the same shape, now reachable only
   * after a real step-up.
   *
   * The token is hashed at rest with the same SHA-256 `hashToken` the refresh
   * tokens use: the row stores only the hash, and only the plaintext is handed
   * back to the caller. A leaked reauth-token table therefore yields no usable
   * step-up tokens. `AccountService.assertReauth` hashes the presented token
   * the same way to look the row up, and consumes it on first use.
   */
  async mintReauthToken(userId: string): Promise<ReauthResult> {
    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + REAUTH_TTL_MS);
    await this.reauthTokens.save({
      userId,
      token: this.hashToken(token),
      expiresAt,
    });
    return { reauthToken: token, expiresAt: expiresAt.toISOString() };
  }

  async rotateRefreshToken(
    rawRefreshToken: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    // 1. Signature/expiry check (throws -> 401).
    try {
      await this.jwtService.verifyAsync(rawRefreshToken, {
        secret: this.configService.getOrThrow<string>('auth.jwtRefreshSecret'),
        // Pin the algorithm to the one we sign with (HS256); an unpinned
        // verifier trusts the token header's `alg`, the algorithm-confusion bug.
        algorithms: ['HS256'],
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

    // 3. Reuse detection: an already-revoked token presented again = theft —
    //    UNLESS it was rotated moments ago and we know what replaced it, which
    //    is the signature of two of the member's own clients refreshing the
    //    same expiring cookie at once (a tab plus the installed PWA; the
    //    frontend's single-flight refresh is per tab). See
    //    `REFRESH_ROTATION_GRACE_MS`.
    if (row.revokedAt) {
      if (this.withinRotationGrace(row)) {
        return this.issueGraceReplacement(row, userAgent);
      }
      await this.revokeAllUserSessions(row.userId, 'reuse-detected', {
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
      // Same family, same start time: this is the SAME session continuing, and
      // the member's device list must not report it as a new sign-in.
      const tokens = await this.issueTokensWithRow(
        user,
        {
          familyId: row.familyId,
          sessionStartedAt: row.sessionStartedAt,
        },
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
      // Re-read: the winner of the race has committed by now, so the row
      // carries its `revoked_at`/`replaced_by`. Inside the grace window this
      // is the same benign two-client race as above, not theft.
      const rotated = await this.refreshTokens.findOne({
        where: { id: row.id },
      });
      if (rotated && this.withinRotationGrace(rotated)) {
        return this.issueGraceReplacement(rotated, userAgent);
      }
      await this.revokeAllUserSessions(row.userId, 'reuse-detected', {
        rowId: row.id,
        userAgent,
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    this.announceSessionRefreshed(row.userId);
    return {
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken,
    };
  }

  /**
   * Announce a successful refresh so the profiles module can coarsen it into
   * the member's "recently active" month (see `session-activity.events.ts`).
   *
   * Fire-and-forget by design: the listener owns its own once-a-day guard and
   * swallows its own failures, and a refresh must never fail because a
   * directory ornament could not be written. Emitted from BOTH refresh
   * outcomes, the ordinary rotation and the grace-window replacement, since
   * both mean the same thing about the member: they are here right now.
   */
  private announceSessionRefreshed(userId: string): void {
    this.eventEmitter.emit(SESSION_REFRESHED, {
      userId,
      at: new Date(),
    } satisfies SessionRefreshedEvent);
  }

  /**
   * True when this row was rotated by a legitimate refresh a moment ago —
   * `replaced_by` is set (so a rotation, not a logout or a family revocation)
   * and `revoked_at` is inside the grace window.
   */
  private withinRotationGrace(row: RefreshToken): boolean {
    return (
      Boolean(row.revokedAt) &&
      Boolean(row.replacedBy) &&
      Date.now() - (row.revokedAt as Date).getTime() <=
        REFRESH_ROTATION_GRACE_MS
    );
  }

  /**
   * Answer a lost rotation race with a fresh, valid pair instead of revoking
   * the family.
   *
   * We cannot hand back the pair the winner received: only sha-256 hashes of
   * refresh tokens are stored, never the tokens themselves. Minting a new pair
   * is equivalent for the client (it ends up holding one working cookie) and
   * costs one extra `refresh_tokens` row that nobody holds the plaintext for —
   * it simply ages out, invisibly. Reuse detection outside the window is
   * unchanged, so a stolen token replayed later still burns every session the
   * member has.
   *
   * The replacement stays in the SAME family as the row that lost the race.
   * It used to start a fresh one (`issueTokens`), which left the race winner's
   * still-live row stranded as a second family: one browser, two entries in the
   * member's device list, and no way to tell which was which. Same family means
   * the security page shows one session and revoking it kills both rows. We
   * cannot simply revoke the winner's row instead — its holder is a live client
   * that would present it after the 10-second grace window and trip reuse
   * detection, signing the member out everywhere.
   */
  private async issueGraceReplacement(
    row: RefreshToken,
    userAgent?: string,
  ): Promise<TokenPair> {
    const user = await this.usersService.findByIdWithEmail(row.userId);
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    // `log`, not `warn`: this is an expected multi-client race, and logging it
    // at the same level as a real theft signal is what diluted that signal.
    this.logger.log(
      `Refresh rotation race absorbed within the grace window: userId=${row.userId} rowId=${row.id} familyId=${row.familyId}`,
    );
    const { accessToken, refreshToken } = await this.issueTokensWithRow(
      user,
      { familyId: row.familyId, sessionStartedAt: row.sessionStartedAt },
      userAgent,
    );
    this.announceSessionRefreshed(row.userId);
    return { accessToken, refreshToken };
  }

  async revokeRefreshToken(rawRefreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawRefreshToken);
    // Look the row up first so we know whose live sockets to drop. A missing or
    // already-revoked token is a no-op (logout is best-effort).
    const row = await this.refreshTokens.findOne({ where: { tokenHash } });
    if (!row || row.revokedAt) {
      return;
    }
    // Revoke the whole FAMILY, not just the presenting row. A device that lost
    // a rotation race holds one live row while its stranded sibling holds
    // another (see `issueGraceReplacement`); revoking only the row in hand left
    // the sibling live and this device still listed as signed in.
    const result = await this.refreshTokens.update(
      { familyId: row.familyId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    // Never log the token itself — only that a revocation happened.
    this.logger.log(
      `Revoked ${result.affected ?? 0} refresh token(s) on logout`,
    );
    // Force-disconnect this member's live WebSocket sockets — an open socket
    // otherwise outlives logout (the chat gateway consumes this event).
    this.eventEmitter.emit(USER_SESSION_REVOKED, {
      userId: row.userId,
    } satisfies UserSessionRevokedEvent);
  }

  /** Revoke every live refresh token for a user (logout-all / global sign-out). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.revokeAllUserSessions(userId, 'logout-all');
  }

  // --- internals ---

  /**
   * Revoke all of a user's currently-live refresh tokens in one statement and
   * emit a security log line. Used for both explicit logout-all and reuse
   * detection. Logs never include token values/secrets.
   */
  private async revokeAllUserSessions(
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
    session: SessionIdentity,
    userAgent?: string,
    id?: string,
    manager?: EntityManager,
  ): Promise<RefreshToken> {
    const repo = manager
      ? manager.getRepository(RefreshToken)
      : this.refreshTokens;
    const decoded = this.jwtService.decode<{ exp: number }>(refreshToken);
    const row = repo.create({
      // A pre-generated id lets the rotation claim reference `replaced_by`
      // before the new row is inserted, keeping both writes in one transaction.
      ...(id ? { id } : {}),
      userId,
      familyId: session.familyId,
      sessionStartedAt: session.sessionStartedAt,
      tokenHash: this.hashToken(refreshToken),
      expiresAt: new Date(decoded.exp * 1000),
      userAgent: userAgent ?? null,
      // Derived here rather than passed in, so every row that carries a UA
      // carries the matching label — a rotation cannot leave a family half
      // labelled, and `recogniseDevice` never has to fall back to re-parsing.
      deviceLabel: deviceLabelFromUserAgent(userAgent),
      // Stamped on every mint, so the newest row in a family always answers
      // "when was this session last seen?" without the caller having to know
      // that rotation is what mints rows.
      lastSeenAt: new Date(),
    });
    return repo.save(row);
  }

  // Issue tokens AND return the persisted refresh-row id (for replaced_by linkage).
  private async issueTokensWithRow(
    user: User,
    session: SessionIdentity,
    userAgent?: string,
    rowId?: string,
    manager?: EntityManager,
  ): Promise<TokenPair & { rowId: string }> {
    // `status`/`role` are advisory-only claims: see the doc on
    // `AccessTokenPayload`. `JwtStrategy.validate` ignores them and re-reads
    // the row, and nothing else may authorise on them.
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
      session,
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

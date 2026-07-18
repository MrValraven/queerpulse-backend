import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import {
  USER_SESSION_REVOKED,
  UserSessionRevokedEvent,
} from '../chat/session.events';
import { User, UserStatus } from '../users/entities/user.entity';
import { AccountExportService } from './account-export.service';
import {
  DeletionRequestResponse,
  DsarResponse,
  EmailPreferenceResponse,
  ExportJobResponse,
  ReauthResult,
  SessionResponse,
  toDeletionRequestResponse,
  toDsarResponse,
  toExportJobResponse,
  toSessionResponse,
} from './account-response';
import {
  DAY_MS,
  DEFAULT_EMAIL_PREFERENCES,
  DELETION_GRACE_DAYS,
  DSAR_DUE_DAYS,
  LOCKED_EMAIL_CATEGORIES,
  REAUTH_TTL_MS,
} from './account.constants';
import { DeactivateDto } from './dto/deactivate.dto';
import { RequestDeletionDto } from './dto/request-deletion.dto';
import { RequestExportDto } from './dto/request-export.dto';
import { SubmitDsarDto } from './dto/submit-dsar.dto';
import { UpdateEmailPreferenceDto } from './dto/update-email-preferences.dto';
import { AccountDeactivation } from './entities/account-deactivation.entity';
import { AccountReauthToken } from './entities/account-reauth-token.entity';
import {
  DataExportFormat,
  DataExportJob,
  DataExportStatus,
} from './entities/data-export-job.entity';
import {
  DeletionRequest,
  DeletionRequestStatus,
} from './entities/deletion-request.entity';
import { DsarRequest, DsarStatus } from './entities/dsar-request.entity';
import { EmailPreference } from './entities/email-preference.entity';

// Re-exported for tests/consumers that historically imported the default
// matrix from this module.
export { DEFAULT_EMAIL_PREFERENCES };

@Injectable()
export class AccountService {
  constructor(
    @InjectRepository(DeletionRequest)
    private readonly deletionRequests: Repository<DeletionRequest>,
    @InjectRepository(DsarRequest)
    private readonly dsarRequests: Repository<DsarRequest>,
    @InjectRepository(DataExportJob)
    private readonly exportJobs: Repository<DataExportJob>,
    @InjectRepository(EmailPreference)
    private readonly emailPreferences: Repository<EmailPreference>,
    @InjectRepository(AccountReauthToken)
    private readonly reauthTokens: Repository<AccountReauthToken>,
    @InjectRepository(AccountDeactivation)
    private readonly deactivations: Repository<AccountDeactivation>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    private readonly exportService: AccountExportService,
    // Deactivation and deletion each write a ledger row AND flip
    // `users.status` — the two must commit together or the member is hidden
    // with no way back (or has a way back without being hidden).
    private readonly dataSource: DataSource,
    // Drops live sockets on deactivation/deletion — see revokeAllSessions.
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // --- Step-up re-authentication -------------------------------------------

  // Auth is OAuth-only, so there is nothing to verify a password against —
  // this simply records that the caller re-confirmed their session right now
  // and mints a short-lived token the destructive/export routes require.
  async reauth(userId: string): Promise<ReauthResult> {
    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + REAUTH_TTL_MS);
    await this.reauthTokens.save({ userId, token, expiresAt });
    return { reauthToken: token, expiresAt: expiresAt.toISOString() };
  }

  private async assertReauth(
    userId: string,
    token: string | undefined,
  ): Promise<void> {
    if (!token) {
      throw new UnauthorizedException('Recent re-authentication required');
    }
    const row = await this.reauthTokens.findOne({ where: { userId, token } });
    if (!row || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Recent re-authentication required');
    }
  }

  // --- Deactivation (reversible, non-erasure) ------------------------------

  /**
   * Resolve the status to record as "what to come back to".
   *
   * Reads through a `Deactivated` current status to the value stashed on
   * whichever ledger row already exists, so a member who deactivates, then
   * requests deletion (or deactivates twice) does not end up with
   * `previous_status = 'deactivated'` — which would strand them.
   *
   * SUSPENDED MEMBERS: deliberately allowed to deactivate and to request
   * deletion. Erasure is a GDPR right that cannot be conditioned on good
   * standing, and deactivation is strictly *more* restrictive than suspension
   * (both already fail `ActiveMemberGuard`), so permitting it grants a
   * suspended member nothing. The abuse to defend against is not the
   * deactivation, it is the *return* — which is why the prior status is
   * recorded here and replayed verbatim on restore instead of defaulting to
   * `Active`.
   */
  private async resolveRestoreStatus(
    manager: EntityManager,
    userId: string,
  ): Promise<UserStatus> {
    const user = await manager.findOne(User, {
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.status !== UserStatus.Deactivated) {
      return user.status;
    }
    const openDeactivation = await manager.findOne(AccountDeactivation, {
      where: { userId, reactivatedAt: IsNull() },
    });
    const openDeletion = await manager.findOne(DeletionRequest, {
      where: { userId, status: DeletionRequestStatus.Grace },
    });
    return (
      openDeactivation?.previousStatus ??
      openDeletion?.previousStatus ??
      UserStatus.Active
    );
  }

  async deactivate(
    userId: string,
    dto: DeactivateDto,
  ): Promise<{ status: 'deactivated' }> {
    await this.assertReauth(userId, dto.reauthToken);
    // The ledger row and `users.status` are one atomic fact: a row without the
    // status change hides nobody (the bug this replaces), and a status change
    // without the row leaves the member with no recorded way back.
    await this.dataSource.transaction(async (manager) => {
      const previousStatus = await this.resolveRestoreStatus(manager, userId);
      const existing = await manager.findOne(AccountDeactivation, {
        where: { userId },
      });
      await manager.save(AccountDeactivation, {
        ...(existing ?? {}),
        userId,
        deactivatedAt: new Date(),
        reactivatedAt: null,
        previousStatus,
      });
      // This is what actually hides them: every `status = 'active'` predicate
      // in the codebase (search, feed, member refs, guards, chat handshake)
      // stops matching.
      await manager.update(
        User,
        { id: userId },
        { status: UserStatus.Deactivated },
      );
    });
    // Deactivating is a full sign-out everywhere, including this device.
    await this.revokeAllSessions(userId);
    return { status: 'deactivated' };
  }

  // --- Right to erasure — account deletion ---------------------------------

  async requestDeletion(
    userId: string,
    dto: RequestDeletionDto,
  ): Promise<DeletionRequestResponse> {
    await this.assertReauth(userId, dto.reauthToken);
    const active = await this.deletionRequests.findOne({
      where: { userId, status: DeletionRequestStatus.Grace },
    });
    if (active) {
      throw new ConflictException('A deletion request is already scheduled');
    }
    const scheduledFor = new Date(Date.now() + DELETION_GRACE_DAYS * DAY_MS);
    // The delete-account UI says "everything is hidden now and will be
    // permanently erased on {date}". The erasure half was already true; the
    // hiding half was not — the request row was written and nothing read it.
    // Setting `Deactivated` in the same transaction as the row is what makes
    // the first clause true, via the `status = 'active'` filters that already
    // exist everywhere.
    const saved = await this.dataSource.transaction(async (manager) => {
      const previousStatus = await this.resolveRestoreStatus(manager, userId);
      const row = await manager.save(DeletionRequest, {
        userId,
        status: DeletionRequestStatus.Grace,
        scheduledFor,
        reason: dto.reason ?? null,
        previousStatus,
      });
      await manager.update(
        User,
        { id: userId },
        { status: UserStatus.Deactivated },
      );
      return row;
    });
    // Opening the grace period kills the member's sessions server-side.
    await this.revokeAllSessions(userId);
    return toDeletionRequestResponse(saved, DELETION_GRACE_DAYS);
  }

  async getDeletionRequest(
    userId: string,
  ): Promise<DeletionRequestResponse | null> {
    const active = await this.deletionRequests.findOne({
      where: [
        { userId, status: DeletionRequestStatus.Grace },
        { userId, status: DeletionRequestStatus.Processing },
      ],
      order: { createdAt: 'DESC' },
    });
    return active
      ? toDeletionRequestResponse(active, DELETION_GRACE_DAYS)
      : null;
  }

  async cancelDeletionRequest(userId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const active = await manager.findOne(DeletionRequest, {
        where: { userId, status: DeletionRequestStatus.Grace },
      });
      if (!active) {
        throw new NotFoundException('No pending deletion request');
      }
      active.status = DeletionRequestStatus.Cancelled;
      await manager.save(DeletionRequest, active);

      // Changing your mind about erasure un-hides you — UNLESS you were also
      // separately deactivated. Someone who paused their account and *then*
      // asked to be erased is cancelling only the erasure; they asked to stay
      // hidden, and silently un-pausing them here would be a second broken
      // promise in the opposite direction. Their open `account_deactivation`
      // row keeps them `Deactivated` until they sign back in.
      const openDeactivation = await manager.findOne(AccountDeactivation, {
        where: { userId, reactivatedAt: IsNull() },
      });
      if (openDeactivation) {
        return;
      }
      // Restore the recorded status, never a hardcoded `Active` — a suspended
      // member must land back on `Suspended`. The `status: Deactivated`
      // predicate makes this a no-op if something else already moved them
      // (e.g. a moderator acting during the grace period).
      await manager.update(
        User,
        { id: userId, status: UserStatus.Deactivated },
        { status: active.previousStatus ?? UserStatus.Active },
      );
    });
  }

  // --- Right to portability — data export (job) -----------------------------

  // No real worker/queue: the archive is built synchronously and the job is
  // created already `Ready`. See `AccountExportService.build` for the size
  // risk that carries.
  //
  // FORMAT: `dto.format` (`json` | `csv` | `both`) is persisted on the job and
  // then IGNORED — this backend only ever produces JSON. A member who picks
  // `csv` or `both` gets a `.json` archive. The column is kept because the
  // frontend sends it and the eventual worker will need it; nothing downstream
  // reads it today. Do not assume CSV works because the enum has a value for it.
  async requestExport(
    userId: string,
    dto: RequestExportDto,
  ): Promise<ExportJobResponse> {
    // Step-up auth, REQUIRED — matching `deactivate`, `requestDeletion` and
    // `submitDsar`. An export is a complete dump of everything we hold on a
    // person, so a stolen session cookie alone must not be enough to exfiltrate
    // it. The frontend mints the token inside `useExportFlow.start()` (live
    // branch only), so no page has to know this route needs one.
    await this.assertReauth(userId, dto.reauthToken);
    const now = new Date();
    const job = await this.exportJobs.save({
      userId,
      status: DataExportStatus.Ready,
      categories: dto.categories,
      format: dto.format as DataExportFormat,
      requestedAt: now,
      generatedAt: now,
      data: await this.exportService.build(userId, dto.categories),
      error: null,
    });
    return toExportJobResponse(job);
  }

  /**
   * Backs `GET /account/export/:jobId/download`. Returns the raw archive for
   * the controller to stream, scoped to the owning user by the same
   * `{ id, userId }` lookup `getExportJob` uses — a job id is a uuid, but it is
   * not a capability, so ownership is checked rather than assumed.
   */
  async getExportDownload(
    userId: string,
    jobId: string,
  ): Promise<{ filename: string; body: Buffer }> {
    const job = await this.exportJobs.findOne({ where: { id: jobId, userId } });
    if (!job) {
      throw new NotFoundException('Export job not found');
    }
    if (job.status !== DataExportStatus.Ready || !job.data) {
      throw new NotFoundException('Export archive is not ready');
    }
    return {
      filename: `queerpulse-export-${job.id}.json`,
      body: Buffer.from(JSON.stringify(job.data, null, 2), 'utf8'),
    };
  }

  async getExportJob(
    userId: string,
    jobId: string,
  ): Promise<ExportJobResponse> {
    const job = await this.exportJobs.findOne({
      where: { id: jobId, userId },
    });
    if (!job) {
      throw new NotFoundException('Export job not found');
    }
    return toExportJobResponse(job);
  }

  // --- DSAR intake & tracking ------------------------------------------------

  async submitDsar(userId: string, dto: SubmitDsarDto): Promise<DsarResponse> {
    await this.assertReauth(userId, dto.reauthToken);
    const submittedAt = new Date();
    const dueBy = new Date(submittedAt.getTime() + DSAR_DUE_DAYS * DAY_MS);
    const saved = await this.dsarRequests.save({
      userId,
      reference: this.generateDsarReference(),
      article: dto.article,
      status: DsarStatus.Received,
      scopes: dto.scopes,
      details: dto.details,
      context: dto.context ?? null,
      submittedAt,
      dueBy,
      respondedAt: null,
    });
    return toDsarResponse(saved);
  }

  async listDsar(userId: string): Promise<DsarResponse[]> {
    const rows = await this.dsarRequests.find({
      where: { userId },
      order: { submittedAt: 'DESC' },
    });
    return rows.map(toDsarResponse);
  }

  private generateDsarReference(): string {
    return `DSAR-${randomBytes(4).toString('hex').toUpperCase()}`;
  }

  // --- Sessions (backed by the existing refresh-token store) ----------------

  // The presenting `refresh_token` cookie identifies THIS device's session.
  // We resolve it to a refresh-token row id by the same sha-256 allowlist hash
  // `AuthService` uses, so we can flag `current` and exclude it from
  // "sign out other devices".
  private async resolveCurrentSessionId(
    rawRefreshToken: string | undefined,
  ): Promise<string | null> {
    if (!rawRefreshToken) {
      return null;
    }
    const tokenHash = createHash('sha256')
      .update(rawRefreshToken)
      .digest('hex');
    const row = await this.refreshTokens.findOne({ where: { tokenHash } });
    return row?.id ?? null;
  }

  async listSessions(
    userId: string,
    rawRefreshToken?: string,
  ): Promise<SessionResponse[]> {
    const currentId = await this.resolveCurrentSessionId(rawRefreshToken);
    const rows = await this.refreshTokens.find({
      where: { userId, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    return rows.map((t) => toSessionResponse(t, t.id === currentId));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const row = await this.refreshTokens.findOne({
      where: { id: sessionId, userId },
    });
    if (!row || row.revokedAt) {
      throw new NotFoundException('Session not found');
    }
    row.revokedAt = new Date();
    await this.refreshTokens.save(row);
  }

  // "Log out other devices": revoke every live session EXCEPT the presenting
  // one, so the caller stays signed in on this device. FE `revokeOtherSessions`.
  async revokeOtherSessions(
    userId: string,
    rawRefreshToken?: string,
  ): Promise<void> {
    const currentId = await this.resolveCurrentSessionId(rawRefreshToken);
    const rows = await this.refreshTokens.find({
      where: { userId, revokedAt: IsNull() },
    });
    const now = new Date();
    const toRevoke = rows.filter((r) => r.id !== currentId);
    if (toRevoke.length === 0) {
      return;
    }
    for (const row of toRevoke) {
      row.revokedAt = now;
    }
    await this.refreshTokens.save(toRevoke);
  }

  /**
   * Revoke ALL live sessions including the caller's (used by deactivate and
   * deletion, where the account itself is going away).
   *
   * Revoking refresh tokens is not sufficient on its own: an already-issued
   * ACCESS token stays valid for its full TTL (15m by default), and
   * `ChatGateway.authenticate` reads `status` straight off that token's claims
   * without touching the DB. So a member who deactivates mid-session would keep
   * a working socket — still visible in presence, still receiving messages —
   * for up to 15 minutes after every HTTP route had started rejecting them.
   *
   * Emitting `USER_SESSION_REVOKED` closes that window: the gateway already
   * listens for it and drops the member's sockets immediately. This mirrors
   * what `AuthService.revokeFamily` does on reuse detection.
   */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.refreshTokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    this.eventEmitter.emit(USER_SESSION_REVOKED, {
      userId,
    } satisfies UserSessionRevokedEvent);
  }

  // --- Email preferences ------------------------------------------------------

  async getEmailPreferences(
    userId: string,
  ): Promise<EmailPreferenceResponse[]> {
    const rows = await this.emailPreferences.find({ where: { userId } });
    const overrides = new Map(rows.map((r) => [r.category, r.enabled]));
    return Object.entries(DEFAULT_EMAIL_PREFERENCES).map(
      ([category, defaultEnabled]) => {
        const locked = LOCKED_EMAIL_CATEGORIES.has(category);
        return {
          category,
          // Locked (ALWAYS_ON) categories are never off, regardless of stored
          // rows.
          email: locked ? true : (overrides.get(category) ?? defaultEnabled),
          ...(locked ? { locked: true } : {}),
        };
      },
    );
  }

  async updateEmailPreference(
    userId: string,
    dto: UpdateEmailPreferenceDto,
  ): Promise<EmailPreferenceResponse[]> {
    // ALWAYS_ON transactional categories cannot be toggled off.
    if (!LOCKED_EMAIL_CATEGORIES.has(dto.category)) {
      const existing = await this.emailPreferences.findOne({
        where: { userId, category: dto.category },
      });
      await this.emailPreferences.save({
        ...(existing ?? {}),
        userId,
        category: dto.category,
        enabled: dto.email,
      });
    }
    return this.getEmailPreferences(userId);
  }
}

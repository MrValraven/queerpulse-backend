import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
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

  async deactivate(
    userId: string,
    dto: DeactivateDto,
  ): Promise<{ status: 'deactivated' }> {
    await this.assertReauth(userId, dto.reauthToken);
    const existing = await this.deactivations.findOne({ where: { userId } });
    await this.deactivations.save({
      ...(existing ?? {}),
      userId,
      deactivatedAt: new Date(),
      reactivatedAt: null,
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
    const saved = await this.deletionRequests.save({
      userId,
      status: DeletionRequestStatus.Grace,
      scheduledFor,
      reason: dto.reason ?? null,
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
    const active = await this.deletionRequests.findOne({
      where: { userId, status: DeletionRequestStatus.Grace },
    });
    if (!active) {
      throw new NotFoundException('No pending deletion request');
    }
    active.status = DeletionRequestStatus.Cancelled;
    await this.deletionRequests.save(active);
  }

  // --- Right to portability — data export (job) -----------------------------

  // No real worker/queue in this scaffold: the archive is built synchronously
  // and the job is created already `Ready`.
  async requestExport(
    userId: string,
    dto: RequestExportDto,
  ): Promise<ExportJobResponse> {
    const now = new Date();
    const job = await this.exportJobs.save({
      userId,
      status: DataExportStatus.Ready,
      categories: dto.categories,
      format: dto.format as DataExportFormat,
      requestedAt: now,
      generatedAt: now,
      data: this.buildExportPayload(userId, dto.categories),
      error: null,
    });
    return toExportJobResponse(job);
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

  private buildExportPayload(
    userId: string,
    categories: string[],
  ): Record<string, unknown> {
    return {
      manifest: {
        exportedAt: new Date().toISOString(),
        schemaVersion: '1.0',
        categories,
      },
      userId,
    };
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

  // Revoke ALL live sessions including the caller's (used by deactivate and
  // deletion, where the account itself is going away).
  async revokeAllSessions(userId: string): Promise<void> {
    await this.refreshTokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
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

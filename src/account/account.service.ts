import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  IsNull,
  MoreThan,
  Repository,
} from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { isUniqueViolation } from '../common/db-errors';
import {
  USER_SESSION_REVOKED,
  UserSessionRevokedEvent,
} from '../chat/session.events';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AccountExportService } from './account-export.service';
import {
  DeletionRequestResponse,
  DsarResponse,
  ExportJobResponse,
  SessionResponse,
  exportLinkExpiresAt,
  toDeletionRequestResponse,
  toDsarResponse,
  toExportJobResponse,
  toSessionResponse,
} from './account-response';
import {
  DAY_MS,
  DELETION_GRACE_DAYS,
  DSAR_DUE_DAYS,
  EXPORT_REUSE_WINDOW_MS,
} from './account.constants';
import { DeactivateDto } from './dto/deactivate.dto';
import { RequestDeletionDto } from './dto/request-deletion.dto';
import { RequestExportDto } from './dto/request-export.dto';
import { SubmitDsarDto } from './dto/submit-dsar.dto';
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
import { ExportDownload, describeExportDownload } from './export-archive';

/** Order-insensitive comparison of two already-de-duplicated category lists. */
function sameCategorySet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const seen = new Set(left);
  return right.every((category) => seen.has(category));
}

@Injectable()
export class AccountService {
  constructor(
    @InjectRepository(DeletionRequest)
    private readonly deletionRequests: Repository<DeletionRequest>,
    @InjectRepository(DsarRequest)
    private readonly dsarRequests: Repository<DsarRequest>,
    @InjectRepository(DataExportJob)
    private readonly exportJobs: Repository<DataExportJob>,
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
    // `countAdmins` backs `assertNotSoleAdmin` — the same last-admin guard
    // `AdminMembersService.updateRole` uses against demotion, reused here
    // against self-deactivation/self-deletion.
    private readonly usersService: UsersService,
  ) {}

  // --- Step-up re-authentication -------------------------------------------

  // Auth is OAuth-only, so there is nothing to verify a password against —
  // the token itself is minted only by `AuthService.mintReauthToken`, reached
  // by completing a real Google OAuth round trip with `prompt=login` as the
  // SAME already-signed-in member (`AuthController.googleCallback`'s `reauth`
  // branch). This just validates whatever token the caller presents.
  //
  // The stored copy is SHA-256 hashed (see `AuthService.mintReauthToken`), so
  // the presented plaintext is hashed the same way before the lookup. On a
  // match the row is CONSUMED — deleted in the same step — making a reauth
  // token strictly single-use: one step-up authorizes exactly one destructive
  // or export action, never several within the 5-minute TTL. The conditional
  // delete doubles as the concurrency guard, so two requests racing the same
  // token can never both pass (exactly one wins the `affected` claim).
  private async assertReauth(
    userId: string,
    token: string | undefined,
  ): Promise<void> {
    if (!token) {
      throw new UnauthorizedException('Recent re-authentication required');
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = await this.reauthTokens.findOne({
      where: { userId, token: tokenHash },
    });
    if (!row || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Recent re-authentication required');
    }
    const consumed = await this.reauthTokens.delete({ id: row.id });
    if (!consumed.affected) {
      // Lost the race — another concurrent action already consumed this token.
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

  /**
   * Blocks self-deactivation/self-deletion for the platform's sole remaining
   * Admin. `AdminMembersService.updateRole` already guards this lockout for
   * role-demotion; this is the more realistic path to the same dead end — a
   * lone admin pausing or erasing their own account through ordinary member
   * settings, with no other admin left to reverse it. Reads through the
   * caller's transaction `manager` (via `UsersService.countAdmins`), matching
   * `updateRole`'s "count inside the same transaction as the write" guard, so
   * a concurrent action against a different admin can't slip past a stale
   * count.
   */
  private async assertNotSoleAdmin(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const user = await manager.findOne(User, {
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (user?.role !== UserRole.Admin) {
      return;
    }
    const adminCount = await this.usersService.countAdmins(manager);
    if (adminCount <= 1) {
      throw new ConflictException(
        'You’re the only remaining admin. Promote another member to admin before deactivating or deleting your account.',
      );
    }
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
      await this.assertNotSoleAdmin(manager, userId);
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
    const scheduledFor = new Date(Date.now() + DELETION_GRACE_DAYS * DAY_MS);
    // The delete-account UI says "everything is hidden now and will be
    // permanently erased on {date}". The erasure half was already true; the
    // hiding half was not — the request row was written and nothing read it.
    // Setting `Deactivated` in the same transaction as the row is what makes
    // the first clause true, via the `status = 'active'` filters that already
    // exist everywhere.
    const saved = await this.dataSource.transaction(async (manager) => {
      await this.assertNotSoleAdmin(manager, userId);
      // The duplicate check lives INSIDE the transaction, and the partial
      // unique index (`UQ_deletion_request_open_user`, migration
      // 1793500200000) is what actually makes it hold: two overlapping calls
      // used to pass an out-of-transaction pre-check and insert two `grace`
      // rows, after which cancelling cleared only one and the erasure sweep
      // deleted the account of a member who had cancelled. `processing` counts
      // as open too — an erasure already in flight is not a fresh request.
      const open = await manager.findOne(DeletionRequest, {
        where: [
          { userId, status: DeletionRequestStatus.Grace },
          { userId, status: DeletionRequestStatus.Processing },
        ],
      });
      if (open) {
        throw new ConflictException('A deletion request is already scheduled');
      }
      const previousStatus = await this.resolveRestoreStatus(manager, userId);
      let row: DeletionRequest;
      try {
        row = await manager.save(DeletionRequest, {
          userId,
          status: DeletionRequestStatus.Grace,
          scheduledFor,
          reason: dto.reason ?? null,
          previousStatus,
        });
      } catch (err) {
        // Lost the race to a concurrent request: the index rejected the second
        // insert. Same 409 the pre-check above raises.
        if (isUniqueViolation(err, 'UQ_deletion_request_open_user')) {
          throw new ConflictException(
            'A deletion request is already scheduled',
          );
        }
        throw err;
      }
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
      // Cancel EVERY open `grace` row, not just the first one found. A member
      // who double-submitted (or whose request predates
      // `UQ_deletion_request_open_user`) could hold more than one, and a
      // survivor is not inert — the erasure sweep acts on any due `grace` row,
      // so leaving one behind erases an account the member just rescued.
      const open = await manager.find(DeletionRequest, {
        where: { userId, status: DeletionRequestStatus.Grace },
        order: { createdAt: 'ASC' },
      });
      // An erasure the sweep has already claimed cannot be called back: the
      // account is being deleted right now. Say so instead of reporting a
      // cancellation that will not hold.
      const processing = await manager.findOne(DeletionRequest, {
        where: { userId, status: DeletionRequestStatus.Processing },
      });
      if (processing) {
        throw new ConflictException(
          'Your account deletion is already being processed and can no longer be cancelled',
        );
      }
      if (open.length === 0) {
        throw new NotFoundException('No pending deletion request');
      }
      const cancelled = await manager.update(
        DeletionRequest,
        { userId, status: DeletionRequestStatus.Grace },
        { status: DeletionRequestStatus.Cancelled },
      );
      if (cancelled.affected === 0) {
        // The sweep claimed the row between the read and the write.
        throw new ConflictException(
          'Your account deletion is already being processed and can no longer be cancelled',
        );
      }
      // The earliest open row holds the status recorded BEFORE any of this
      // hiding happened — later rows only ever read it back through
      // `resolveRestoreStatus`.
      const active = open.find((row) => row.previousStatus !== null) ?? open[0];

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
        { status: active?.previousStatus ?? UserStatus.Active },
      );
    });
  }

  // --- Right to portability — data export (job) -----------------------------

  // No real worker/queue: the archive is built synchronously and the job is
  // created already `Ready`. See `AccountExportService.build` for the size
  // risk that carries.
  //
  // FORMAT: `dto.format` (`json` | `csv` | `both`) is persisted on the job and
  // honoured at DOWNLOAD time, not here. The stored payload is always the same
  // JSON object regardless of format — `describeExportDownload` renders it as a
  // single `.json`, or as a `.zip` of per-category CSVs (plus the `.json` for
  // `both`), when the member actually fetches it. Nothing format-specific is
  // persisted, so re-reading a job never has to reproduce a zip byte-for-byte.
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
    // Range-check the requested categories against what the builder actually
    // knows, and de-duplicate them. Unknown strings used to be persisted
    // verbatim on the job row and then quietly produce nothing.
    const known = new Set(this.exportService.knownCategories());
    const categories = [...new Set(dto.categories)];
    const unknown = categories.filter((category) => !known.has(category));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown export categories: ${unknown.join(', ')}`,
      );
    }
    const now = new Date();
    // Reuse an identical archive built moments ago instead of building and
    // storing a second full copy. `requestExport` runs the whole build inline
    // and writes it into `data_export_job.data` (jsonb), so a repeat request —
    // double-click, retry after a slow response, a second tab — was pure
    // storage and CPU amplification. Paired with the per-route throttle on the
    // controller.
    const reusable = await this.exportJobs.findOne({
      where: {
        userId,
        status: DataExportStatus.Ready,
        generatedAt: MoreThan(new Date(now.getTime() - EXPORT_REUSE_WINDOW_MS)),
        format: dto.format as DataExportFormat,
      },
      order: { generatedAt: 'DESC' },
    });
    if (reusable && sameCategorySet(reusable.categories, categories)) {
      return toExportJobResponse(reusable);
    }
    const job = await this.exportJobs.save({
      userId,
      status: DataExportStatus.Ready,
      categories,
      format: dto.format as DataExportFormat,
      requestedAt: now,
      generatedAt: now,
      data: await this.exportService.build(userId, categories),
      error: null,
    });
    return toExportJobResponse(job);
  }

  /**
   * Backs `GET /account/export/:jobId/download`. Describes the file to serve —
   * a `.json` body or the entry list for a `.zip` — for the controller to
   * stream, scoped to the owning user by the same `{ id, userId }` lookup
   * `getExportJob` uses: a job id is a uuid, but it is not a capability, so
   * ownership is checked rather than assumed.
   *
   * Every failure mode lives in here, BEFORE the controller writes a single
   * response byte. That ordering is load-bearing for the zip path: once headers
   * are on the wire an exception filter has no status code left to change, so
   * "not yours", "not ready" and "expired" have to be decided while a 404 is
   * still possible.
   */
  async getExportDownload(
    userId: string,
    jobId: string,
  ): Promise<ExportDownload> {
    const job = await this.exportJobs.findOne({ where: { id: jobId, userId } });
    if (!job) {
      throw new NotFoundException('Export job not found');
    }
    if (job.status !== DataExportStatus.Ready || !job.data) {
      throw new NotFoundException('Export archive is not ready');
    }
    // ENFORCE the expiry this API has been advertising all along. `expiresAt`
    // on `toExportJobResponse` told the member the link stops working after
    // EXPORT_LINK_EXPIRY_DAYS, and nothing here checked it, so the link kept
    // serving until `AccountRetentionService` nulled the payload at
    // `retention.dataExportArchiveDays`. A member acted on a seven-day promise
    // while the richest single object in the system stayed fetchable for
    // thirty.
    //
    // THE TWO WINDOWS ARE COMPLEMENTARY, NOT A CONTRADICTION. Do not "fix"
    // the apparent inconsistency by widening this to match the sweeper:
    //   - HERE (7 days, EXPORT_LINK_EXPIRY_DAYS): how long the link is honoured.
    //     Short on purpose. It bounds how long a leaked download URL, a shared
    //     screen, or a stale browser tab is worth anything.
    //   - THE SWEEP (30 days, retention.dataExportArchiveDays, see
    //     AccountRetentionService.expireOldDataExportArchives): when the bytes
    //     are actually destroyed and the row flips to `expired`.
    // The gap between them is deliberate slack for the sweeper: it is a cron,
    // it batches, and it can miss a tick. Access must stop on the promised day
    // regardless of whether the job that deletes the payload has run yet.
    //
    // Refused as a 404 rather than a 410, matching the two refusals above: this
    // route's whole contract is that every failure resolves to "no file here"
    // before a single response byte is written (see the note on the zip path
    // above). The message differs from theirs deliberately: the `{ id, userId }`
    // lookup already proved ownership, so an expired-versus-absent distinction
    // is only ever disclosed to the member whose export it is, and telling them
    // to request a fresh one is more useful than a blank "not found".
    const expiresAt = exportLinkExpiresAt(job);
    if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException(
        'This export download link has expired. Request a new export to download your data again.',
      );
    }
    return describeExportDownload(job);
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

  // Which session is THIS device? It comes from the caller's own access token,
  // as the `sid` claim `JwtStrategy` surfaces on `CurrentUserData.sessionId`.
  //
  // It used to be resolved by hashing the presenting `refresh_token` cookie,
  // which never worked on these routes: that cookie is scoped to `Path=/auth`
  // (see `auth-cookies.ts`, where the narrow scope is deliberate and stays), so
  // the browser does not send it to `/account/sessions`. The lookup therefore
  // found nothing every time, the security page flagged no device as current,
  // and `revokeOtherSessions` matched no current session and revoked every one
  // of them including the caller's.
  //
  // A family id, not a row id, for the same reason as everywhere else here:
  // rotation replaces the row roughly every 15 minutes, so a row id names a
  // credential the caller may already have rotated out of, while the family
  // names the session itself.

  /**
   * The caller's live sessions, one entry per DEVICE.
   *
   * Two filters and one grouping stand between the raw table and this list, and
   * each of them fixes a way the page used to over-report:
   *
   *  - `expiresAt > now`. Revocation was the only condition before, so a token
   *    that had simply run out its 30-day life still appeared under "active
   *    now" for the 30 further days the purge job waits before deleting it. It
   *    could not sign anybody in; it just sat there looking like a device.
   *  - grouping by `familyId`. One browser can legitimately hold two live rows
   *    after a rotation race (see `AuthService.issueGraceReplacement`), and it
   *    was listed twice.
   *  - newest row per family. Its `createdAt` is the last time that device
   *    actually rotated a token, which is the closest thing we have to "last
   *    seen"; the family's `sessionStartedAt` supplies the real sign-in time.
   */
  async listSessions(
    userId: string,
    currentSessionId?: string,
  ): Promise<SessionResponse[]> {
    const rows = await this.refreshTokens.find({
      where: {
        userId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
      order: { createdAt: 'DESC' },
    });
    // Rows arrive newest-first, so the first row seen for a family is its
    // newest and every later one is a stranded sibling we fold away.
    const newestPerFamily = new Map<string, RefreshToken>();
    for (const row of rows) {
      if (!newestPerFamily.has(row.familyId)) {
        newestPerFamily.set(row.familyId, row);
      }
    }
    // `currentSessionId === undefined` flags nothing as current rather than
    // matching a family whose id happens to be undefined. That is the read-only
    // half of the same "we do not know which device this is" case that
    // `revokeOtherSessions` refuses outright, and here it is harmless: the list
    // is still correct, it just cannot point at one row.
    return [...newestPerFamily.values()].map((row) =>
      toSessionResponse(
        row,
        currentSessionId !== undefined && row.familyId === currentSessionId,
      ),
    );
  }

  /**
   * "Sign out this device": revoke one named session.
   *
   * `sessionId` is a refresh-token FAMILY id, which is what `listSessions`
   * hands the frontend. Addressing a row id here would have been unusable: the
   * row the page was rendered from is rotated out roughly every 15 minutes, so
   * a member who left the security page open and then clicked Sign out was
   * revoking a token that had already been replaced, leaving the device signed
   * in. Revoking the family covers every live row descended from that sign-in,
   * including a sibling stranded by a rotation race.
   *
   * Emits `USER_SESSION_REVOKED` for the same reason `revokeAllSessions` does.
   * Revoking the refresh rows only stops the NEXT rotation; the access token
   * already issued to that device stays valid for its full TTL, and
   * `ChatGateway.authenticate` accepts it, so without this the "signed out"
   * device kept a live socket (messages, presence) for up to 15 minutes.
   *
   * The drop is still per-MEMBER: the event carries only `userId`, so the
   * gateway empties the whole `user:${userId}` room. The member's other devices
   * reconnect immediately with their own still-valid cookies, so the visible
   * cost is a socket reconnect, and the revoked device cannot come back because
   * its refresh rows are gone.
   *
   * Narrowing it to the one device is now POSSIBLE: access tokens carry a `sid`
   * claim naming this exact family (see `AccessTokenPayload`), so the event
   * could carry `sessionId` and the gateway could drop only the sockets whose
   * handshake token matches. That is a change inside `ChatGateway`, and it is
   * an ergonomics fix rather than a security one: `JwtStrategy.validate` now
   * rejects the revoked device's access token on its next request, and the
   * gateway re-reads the same token at every handshake, so the revoked device
   * cannot reconnect either way.
   */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.refreshTokens.update(
      { familyId: sessionId, userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    // Nothing live under that family: either it was never this member's, or it
    // was signed out from another tab a moment ago. Both are a 404 here, and
    // neither confirms whether the id exists for somebody else.
    if (!result.affected) {
      throw new NotFoundException('Session not found');
    }
    this.eventEmitter.emit(USER_SESSION_REVOKED, {
      userId,
    } satisfies UserSessionRevokedEvent);
  }

  /**
   * "Log out other devices": revoke every live session EXCEPT the caller's own,
   * so they stay signed in on this device. FE `revokeOtherSessions`.
   *
   * Scoped by FAMILY, so the caller keeps every row of their own session (a
   * rotation race can leave two) and loses every row of every other one.
   * Emits `USER_SESSION_REVOKED` on the same reasoning as `revokeSession`; the
   * caller's own socket reconnects on the cookie it still holds.
   *
   * FAILS CLOSED, and that guard is the point of the method rather than a
   * defensive flourish. "Sign out my other devices" and "sign out everything
   * including me" are different acts with different buttons, and a member
   * reaching for the first one is usually reacting to a device they believe is
   * compromised: the one outcome they must not get is being thrown out of the
   * session they are standing in. Without a current session id the filter below
   * excludes nothing and the method silently becomes `revokeAllSessions`, which
   * is exactly what shipped while the id was being read from a cookie the
   * browser never sends here. Refusing means the only route to a mass revoke is
   * somebody deliberately calling the method that says so in its name.
   *
   * The refusal is reachable in exactly one benign case: an access token minted
   * before the deploy that added the `sid` claim, which carries no session id
   * and expires within one access TTL. A 401 sends the client through its
   * silent refresh, and the retry arrives with a `sid` and succeeds.
   */
  async revokeOtherSessions(
    userId: string,
    currentSessionId?: string,
  ): Promise<void> {
    if (!currentSessionId) {
      throw new UnauthorizedException(
        'Cannot identify the current session; sign in again and retry',
      );
    }
    const rows = await this.refreshTokens.find({
      where: { userId, revokedAt: IsNull() },
    });
    const now = new Date();
    const toRevoke = rows.filter((row) => row.familyId !== currentSessionId);
    if (toRevoke.length === 0) {
      return;
    }
    for (const row of toRevoke) {
      row.revokedAt = now;
    }
    await this.refreshTokens.save(toRevoke);
    this.eventEmitter.emit(USER_SESSION_REVOKED, {
      userId,
    } satisfies UserSessionRevokedEvent);
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
   * what `AuthService.revokeAllUserSessions` does on reuse detection.
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
}

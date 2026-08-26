import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import archiver from 'archiver';
import { Request, Response } from 'express';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Readable } from 'node:stream';
import { StorageService } from '../storage/storage.service';
import { AccountService } from './account.service';
import { ExportDownload, ExportEntry } from './export-archive';
import {
  ExportMediaContribution,
  ExportMediaReadFailure,
  buildExportMediaManifest,
} from './export-media';
import { DeactivateDto } from './dto/deactivate.dto';
import { RequestDeletionDto } from './dto/request-deletion.dto';
import { RequestExportDto } from './dto/request-export.dto';
import { SubmitDsarDto } from './dto/submit-dsar.dto';
import { UpdateEmailPreferenceDto } from './dto/update-email-preferences.dto';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// No ActiveMemberGuard: account lifecycle actions (deactivate, deletion,
// export, DSAR, sessions, email preferences) must remain reachable by a
// pending member, same as `consent`/`notifications`.
//
// Step-up re-authentication (`reauthToken`, required below by deactivate/
// deletion/export/DSAR) is no longer minted by a plain POST here — that had
// no actual re-authentication behind it (this is an OAuth-only app; there is
// no password to re-check). It is now minted only by completing a real
// Google OAuth round trip with `prompt=login` as the SAME already-signed-in
// member: `GET /auth/google?reauth=1&redirect=<path>` ->
// `AuthController.googleCallback`'s `reauth` branch ->
// `AuthService.mintReauthToken`. `AccountService.assertReauth` (below) is
// unchanged — it still just validates whatever token the caller presents.
@ApiTags('Account')
@ApiCookieAuth('access_token')
@Controller('account')
export class AccountController {
  private readonly logger = new Logger(AccountController.name);

  constructor(
    private readonly accountService: AccountService,
    // The member's own uploaded files are streamed into the export zip from
    // the bucket at DOWNLOAD time — never carried in `data_export_job.data`.
    // See `streamZip`/`appendStoredEntry`.
    private readonly storage: StorageService,
  ) {}

  @ApiOperation({ summary: 'Deactivate (reversibly hide) the account.' })
  @ApiCreatedResponse({ description: 'Account deactivated.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiUnauthorizedResponse({
    description: 'Not authenticated, or step-up re-authentication required.',
  })
  @ApiNotFoundResponse({ description: 'User not found.' })
  @Post('deactivate')
  deactivate(@CurrentUser() user: CurrentUserData, @Body() dto: DeactivateDto) {
    return this.accountService.deactivate(user.userId, dto);
  }

  @ApiOperation({
    summary: 'Schedule account deletion (opens the grace period).',
  })
  @ApiCreatedResponse({ description: 'Deletion request scheduled.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiUnauthorizedResponse({
    description: 'Not authenticated, or step-up re-authentication required.',
  })
  @ApiConflictResponse({
    description: 'A deletion request is already scheduled.',
  })
  @Post('deletion-request')
  requestDeletion(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: RequestDeletionDto,
  ) {
    return this.accountService.requestDeletion(user.userId, dto);
  }

  @ApiOperation({
    summary: 'Get the pending deletion request, or null if none.',
  })
  @ApiOkResponse({ description: 'The pending deletion request, or null.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Get('deletion-request')
  getDeletionRequest(@CurrentUser() user: CurrentUserData) {
    return this.accountService.getDeletionRequest(user.userId);
  }

  @ApiOperation({ summary: 'Cancel the pending deletion request.' })
  @ApiNoContentResponse({ description: 'Deletion request cancelled.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiNotFoundResponse({ description: 'No pending deletion request.' })
  @Delete('deletion-request')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelDeletionRequest(
    @CurrentUser() user: CurrentUserData,
  ): Promise<void> {
    await this.accountService.cancelDeletionRequest(user.userId);
  }

  @ApiOperation({ summary: 'Request a personal-data export job.' })
  @ApiCreatedResponse({ description: 'Export job created and ready.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiUnauthorizedResponse({
    description: 'Not authenticated, or step-up re-authentication required.',
  })
  // Rate-limited well below the global 120/min/IP bucket: each call builds the
  // member's ENTIRE archive synchronously and stores it as jsonb, so a loop
  // here is a storage and CPU amplifier rather than a normal write. Identical
  // repeats inside the reuse window are answered from the existing job (see
  // `AccountService.requestExport`), so 3/hour is generous for real use.
  @Throttle({ default: { limit: 3, ttl: seconds(3600) } })
  @ApiTooManyRequestsResponse({ description: 'Export rate limit exceeded.' })
  @Post('export')
  requestExport(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: RequestExportDto,
  ) {
    return this.accountService.requestExport(user.userId, dto);
  }

  @ApiOperation({ summary: 'Get the status of a personal-data export job.' })
  @ApiOkResponse({ description: 'The export job.' })
  @ApiBadRequestResponse({ description: 'Malformed job id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiNotFoundResponse({ description: 'Export job not found.' })
  @Get('export/:jobId')
  getExportJob(
    @CurrentUser() user: CurrentUserData,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    return this.accountService.getExportJob(user.userId, jobId);
  }

  // The `downloadUrl` that `toExportJobResponse` has been advertising all
  // along (`account-response.ts`). The frontend renders it as a plain
  // `<a download>` (`DataExportSections.tsx`), so this must be a GET that the
  // browser can follow with cookie auth and get a file back — not a JSON
  // envelope. Ownership is enforced in the service.
  //
  // `format: 'json'` serves the single `.json` exactly as it always has;
  // `csv`/`both` serve a `.zip` streamed through `archiver`. `@Res()` is used
  // WITHOUT `passthrough` because the zip path owns the response lifecycle
  // itself — see `streamZip` for why Nest must not try to finish it for us.
  @ApiOperation({
    summary: 'Download a ready export as a .json file or a .zip archive.',
  })
  @ApiOkResponse({
    description:
      'The export file stream (application/json or application/zip).',
  })
  @ApiBadRequestResponse({ description: 'Malformed job id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiNotFoundResponse({
    description: 'Export job not found, or its archive is not ready.',
  })
  @Get('export/:jobId/download')
  async downloadExport(
    @CurrentUser() user: CurrentUserData,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Res() res: Response,
  ): Promise<void> {
    // Resolve and authorise FIRST. This is the last point at which a failure
    // can still become a 404 instead of a truncated file.
    const download = await this.accountService.getExportDownload(
      user.userId,
      jobId,
    );
    res.set({
      'Content-Type': download.contentType,
      'Content-Disposition': `attachment; filename="${download.filename}"`,
      // The archive is the member's own personal data — never let a proxy or
      // the browser cache keep a copy after the link expires.
      'Cache-Control': 'no-store',
    });

    if (download.kind === 'json') {
      res.set('Content-Length', String(download.body.byteLength));
      res.end(download.body);
      return;
    }

    // No `Content-Length` for the zip: the compressed size is only known once
    // the last deflate block is written, and pre-computing it would mean
    // building the whole archive in memory — the exact thing we are avoiding.
    // Express therefore falls back to chunked transfer-encoding, which is also
    // what makes a mid-stream abort detectable by the client (below).
    await this.streamZip(download, res);
  }

  /**
   * Stream the download's entries as a zip into an already-headered response.
   *
   * BACKPRESSURE: `archive.pipe(res)` is the whole mechanism — `pipe` stops
   * pulling from the archiver whenever `res.write()` returns false and resumes
   * on `drain`, so a slow client throttles compression instead of growing an
   * unbounded output buffer. We never call `toBuffer()`/`concat` on the zip.
   * That is also why a `stored` entry is appended as the bucket's own
   * `Readable` rather than being read into a Buffer first: the member's media
   * is the one part of the archive big enough for the difference to matter, and
   * the backpressure chain now reaches all the way back to the bucket.
   *
   * FAILURE AFTER HEADERS: by the time anything in here can fail, `200` plus
   * `Content-Type: application/zip` are already on the wire, so there is no
   * status code left to change and throwing would only hand Nest's exception
   * filter a response it cannot write to ("Cannot set headers after they are
   * sent"). Instead we destroy the socket: the chunked response ends without
   * its terminating zero-length chunk, which every HTTP client — browsers
   * included — surfaces as a failed download. A visibly broken transfer is
   * strictly better than a `200 OK` carrying a silently truncated, unopenable
   * `.zip`. The returned promise therefore RESOLVES on failure; it never
   * rejects, deliberately.
   *
   * ONE UNREADABLE OBJECT IS NOT A FAILED DOWNLOAD. A member's Art. 20 archive
   * must not be destroyed because a single bucket object has gone missing, so
   * an object that cannot be OPENED is logged, skipped, and recorded in
   * `media/manifest.json` — see `appendMediaEntries`.
   */
  private streamZip(
    download: Extract<ExportDownload, { kind: 'zip' }>,
    res: Response,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const archive = archiver('zip', {
        // Deflate default. The payload is JSON/CSV text and compresses ~10x at
        // this level; level 9 buys single-digit percent for several times the
        // CPU, on a request that is already synchronous. Media is already
        // compressed (JPEG/PNG/WebP) and gains nothing either way.
        zlib: { level: 6 },
      });

      let settled = false;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        this.logger.error(
          `Export archive stream failed: ${error.message}`,
          error.stack,
        );
        archive.destroy();
        res.destroy(error);
        settle();
      };

      archive.on('error', fail);
      // `warning` is archiver's non-fatal channel, and it is non-fatal for
      // FILE sources (a missing path). We append in-memory strings and bucket
      // streams, never a filesystem path, so there is no benign warning
      // available to us — anything arriving here means the archive is not what
      // we promised, and shipping it anyway would be shipping a corrupt export.
      archive.on('warning', fail);
      res.on('error', fail);
      res.on('finish', settle);
      // The member closed the tab or cancelled the download. Stop compressing
      // for a socket nobody is reading.
      res.on('close', () => {
        if (!res.writableFinished) {
          archive.abort();
          settle();
        }
      });

      archive.pipe(res);
      // `finalize` rejects with the same error already delivered to the
      // `error` handler; `fail` is idempotent, and catching keeps it off the
      // unhandled-rejection path. The append pass is async now (media is
      // fetched from the bucket one object at a time), so finalization has to
      // wait for it rather than running in the same tick.
      void this.appendEntries(archive, download, () => settled)
        .then(() => archive.finalize())
        .catch(fail);
    });
  }

  /**
   * Append every entry, in order, then `media/manifest.json`.
   *
   * Sequential on purpose: appending each stored object and waiting for
   * archiver to consume it means exactly ONE bucket connection is open at a
   * time, so a member with a large gallery does not open a connection per
   * object and does not buffer the set anywhere.
   *
   * `isSettled` lets the loop stop early when the response already died (the
   * member cancelled the download, or the archive errored) instead of
   * continuing to pull objects out of the bucket for a socket nobody reads.
   */
  private async appendEntries(
    archive: archiver.Archiver,
    download: Extract<ExportDownload, { kind: 'zip' }>,
    isSettled: () => boolean,
  ): Promise<void> {
    const failedToRead: ExportMediaReadFailure[] = [];
    for (const entry of download.entries) {
      if (isSettled()) {
        return;
      }
      if (entry.kind === 'text') {
        // `date` is pinned to the job's generation time so the same job always
        // yields a byte-identical zip.
        archive.append(entry.content, {
          name: entry.name,
          date: download.modifiedAt,
        });
        continue;
      }
      await this.appendStoredEntry(
        archive,
        entry,
        download.modifiedAt,
        failedToRead,
      );
    }
    this.appendMediaManifest(archive, download, failedToRead);
  }

  /**
   * Append ONE bucket object, or record why it could not be read.
   *
   * The split between the two failure modes is deliberate:
   *
   *  - failing to OPEN the object (deleted key, credentials, network) happens
   *    before a single byte is written, so it is fully recoverable: log, record
   *    it for the manifest, and carry on with the rest of the archive;
   *  - failing PART-WAY through the body is not recoverable — those bytes are
   *    already inside a zip entry whose size and CRC were promised. That error
   *    reaches archiver, which is wired to `fail`, and the download breaks
   *    visibly rather than handing the member a corrupt archive.
   */
  private async appendStoredEntry(
    archive: archiver.Archiver,
    entry: Extract<ExportEntry, { kind: 'stored' }>,
    modifiedAt: Date,
    failedToRead: ExportMediaReadFailure[],
  ): Promise<void> {
    let body: Readable;
    try {
      body = await this.storage.openObjectStream(entry.storageKey);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Export media skipped, could not read ${entry.storageKey}: ${reason}`,
      );
      failedToRead.push({
        name: entry.name.replace(/^media\//, ''),
        storageKey: entry.storageKey,
        reason,
      });
      return;
    }
    archive.append(body, { name: entry.name, date: modifiedAt });
    await this.waitForEntry(archive, entry.name);
  }

  /**
   * Resolve once archiver has finished consuming the named entry.
   *
   * Archiver's `append` is fire-and-forget into an internal queue and exposes
   * no per-append promise, but it emits `entry` with the entry's data as each
   * one completes. Matching on the NAME rather than taking the next event is
   * what keeps exactly one bucket connection open: the text entries were
   * queued first and their `entry` events are still in flight, so a
   * take-the-next-event wait would return on somebody else's completion and
   * let the loop run ahead of the archive. Rejects on archive error so the
   * caller stops pulling objects into a dead archive.
   *
   * `close` is watched as well: a member who cancels the download triggers
   * `archive.abort()`, after which the pending entry never completes. Without
   * that listener this promise would never settle and would hold its handlers
   * (and the bucket stream) for the life of the process.
   */
  private waitForEntry(
    archive: archiver.Archiver,
    name: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanUp = () => {
        archive.removeListener('entry', onEntry);
        archive.removeListener('error', onError);
        archive.removeListener('close', onClose);
      };
      const onEntry = (data: archiver.EntryData) => {
        if (data.name !== name) {
          return;
        }
        cleanUp();
        resolve();
      };
      const onError = (error: Error) => {
        cleanUp();
        reject(error);
      };
      // The archive went away under us. Resolve rather than reject: the caller
      // checks `isSettled()` on its next turn and stops, and a rejection here
      // would be logged as a stream failure for something that already failed
      // (or was cancelled) somewhere the member can see.
      const onClose = () => {
        cleanUp();
        resolve();
      };
      archive.on('entry', onEntry);
      archive.once('error', onError);
      archive.once('close', onClose);
    });
  }

  /**
   * `media/manifest.json` — what the bucket held, what made it into this zip,
   * and what did not.
   *
   * Written LAST because `failedToRead` is only knowable once the streaming
   * pass is done, and written even when the member has NO uploaded files at
   * all: an empty `media/` folder cannot tell "we hold nothing of yours" apart
   * from "everything failed", and Art. 20 is exactly the moment that
   * distinction matters. The manifest doubles as the index, mapping every file
   * in `media/` back to its storage key and its upload kind (avatar, listing
   * photo, gathering photo…).
   */
  private appendMediaManifest(
    archive: archiver.Archiver,
    download: Extract<ExportDownload, { kind: 'zip' }>,
    failedToRead: ExportMediaReadFailure[],
  ): void {
    const media: ExportMediaContribution | null = download.media;
    if (!media) {
      // The member did not request the `media` category (or the job predates
      // it). No `media/` folder at all, and no manifest claiming there is one.
      return;
    }
    archive.append(
      JSON.stringify(buildExportMediaManifest(media, failedToRead), null, 2),
      { name: 'media/manifest.json', date: download.modifiedAt },
    );
  }

  @ApiOperation({ summary: 'Submit a data-subject access request (DSAR).' })
  @ApiCreatedResponse({ description: 'DSAR recorded.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiUnauthorizedResponse({
    description: 'Not authenticated, or step-up re-authentication required.',
  })
  // A DSAR is a human-reviewed intake row carrying up to 4 KB of free text
  // (see SubmitDsarDto's caps). Nobody files five in an hour legitimately, and
  // the global bucket alone allowed 120/min of persisted text per IP.
  @Throttle({ default: { limit: 5, ttl: seconds(3600) } })
  @ApiTooManyRequestsResponse({ description: 'DSAR rate limit exceeded.' })
  @Post('dsar')
  submitDsar(@CurrentUser() user: CurrentUserData, @Body() dto: SubmitDsarDto) {
    return this.accountService.submitDsar(user.userId, dto);
  }

  @ApiOperation({ summary: "List the caller's DSAR requests, newest first." })
  @ApiOkResponse({ description: 'The DSAR requests.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Get('dsar')
  listDsar(@CurrentUser() user: CurrentUserData) {
    return this.accountService.listDsar(user.userId);
  }

  // Read the presenting `refresh_token` cookie in a typed way (Express types
  // `req.cookies` as `any`).
  private presentingRefreshToken(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, string | undefined>;
    return cookies?.['refresh_token'];
  }

  @ApiOperation({ summary: "List the caller's active sessions." })
  @ApiOkResponse({ description: 'The active sessions.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Get('sessions')
  listSessions(@CurrentUser() user: CurrentUserData, @Req() req: Request) {
    return this.accountService.listSessions(
      user.userId,
      this.presentingRefreshToken(req),
    );
  }

  @ApiOperation({ summary: 'Revoke one session.' })
  @ApiNoContentResponse({ description: 'Session revoked.' })
  @ApiBadRequestResponse({ description: 'Malformed session id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiNotFoundResponse({ description: 'Session not found.' })
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.accountService.revokeSession(user.userId, id);
  }

  // "Sign out all other sessions": revoke every session EXCEPT the presenting
  // one (identified by the `refresh_token` cookie), so the caller stays signed
  // in on this device. Matches FE `revokeOtherSessions`.
  @ApiOperation({ summary: 'Sign out all other sessions but this one.' })
  @ApiNoContentResponse({ description: 'Other sessions revoked.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Delete('sessions')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeOtherSessions(
    @CurrentUser() user: CurrentUserData,
    @Req() req: Request,
  ): Promise<void> {
    await this.accountService.revokeOtherSessions(
      user.userId,
      this.presentingRefreshToken(req),
    );
  }

  // NOT-YET-ACTIVE. A transactional mailer DOES exist now (`MailerService`,
  // used by the join-request approve/decline flow), but nothing consults these
  // categories: no digest, reminder or product-update sender reads
  // `email_preference`. The toggles are persisted and never acted on, so every
  // item still comes back with `comingSoon: true`.
  @ApiOperation({
    summary:
      "Get the caller's email-notification preferences. NOTE: no sender consults these categories yet, so toggles are stored but not acted on (every item carries comingSoon: true).",
  })
  @ApiOkResponse({
    description: 'The email preferences (delivery not yet active).',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Get('email-preferences')
  getEmailPreferences(@CurrentUser() user: CurrentUserData) {
    return this.accountService.getEmailPreferences(user.userId);
  }

  // PATCH (not POST): this partially updates an existing settings resource and
  // is idempotent. API CONTRACT CHANGE — the frontend must call PATCH
  // /account/email-preferences (was POST).
  @ApiOperation({
    summary:
      'Update one email-notification preference. NOTE: no sender consults these categories yet, so the toggle is persisted but nothing changes about what is sent.',
  })
  @ApiOkResponse({
    description: 'The updated email preferences (delivery not yet active).',
  })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Patch('email-preferences')
  updateEmailPreference(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateEmailPreferenceDto,
  ) {
    return this.accountService.updateEmailPreference(user.userId, body);
  }
}

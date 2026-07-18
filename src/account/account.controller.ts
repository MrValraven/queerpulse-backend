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
import { AccountService } from './account.service';
import { ExportEntry } from './export-archive';
import { DeactivateDto } from './dto/deactivate.dto';
import { ReauthDto } from './dto/reauth.dto';
import { RequestDeletionDto } from './dto/request-deletion.dto';
import { RequestExportDto } from './dto/request-export.dto';
import { SubmitDsarDto } from './dto/submit-dsar.dto';
import { UpdateEmailPreferenceDto } from './dto/update-email-preferences.dto';

// No ActiveMemberGuard: account lifecycle actions (reauth, deactivate,
// deletion, export, DSAR, sessions, email preferences) must remain reachable
// by a pending member, same as `consent`/`notifications`.
@Controller('account')
export class AccountController {
  private readonly logger = new Logger(AccountController.name);

  constructor(private readonly accountService: AccountService) {}

  @Post('reauth')
  reauth(
    @CurrentUser() user: CurrentUserData,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Body() _dto: ReauthDto,
  ) {
    return this.accountService.reauth(user.userId);
  }

  @Post('deactivate')
  deactivate(@CurrentUser() user: CurrentUserData, @Body() dto: DeactivateDto) {
    return this.accountService.deactivate(user.userId, dto);
  }

  @Post('deletion-request')
  requestDeletion(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: RequestDeletionDto,
  ) {
    return this.accountService.requestDeletion(user.userId, dto);
  }

  @Get('deletion-request')
  getDeletionRequest(@CurrentUser() user: CurrentUserData) {
    return this.accountService.getDeletionRequest(user.userId);
  }

  @Delete('deletion-request')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelDeletionRequest(
    @CurrentUser() user: CurrentUserData,
  ): Promise<void> {
    await this.accountService.cancelDeletionRequest(user.userId);
  }

  @Post('export')
  requestExport(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: RequestExportDto,
  ) {
    return this.accountService.requestExport(user.userId, dto);
  }

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
    await this.streamZip(download.entries, download.modifiedAt, res);
  }

  /**
   * Stream the entries as a zip into an already-headered response.
   *
   * BACKPRESSURE: `archive.pipe(res)` is the whole mechanism — `pipe` stops
   * pulling from the archiver whenever `res.write()` returns false and resumes
   * on `drain`, so a slow client throttles compression instead of growing an
   * unbounded output buffer. We never call `toBuffer()`/`concat` on the zip.
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
   */
  private streamZip(
    entries: ExportEntry[],
    modifiedAt: Date,
    res: Response,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const archive = archiver('zip', {
        // Deflate default. The payload is JSON/CSV text and compresses ~10x at
        // this level; level 9 buys single-digit percent for several times the
        // CPU, on a request that is already synchronous.
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
      // FILE sources (a missing path). We only ever append in-memory strings,
      // so there is no benign warning available to us — anything arriving here
      // means the archive is not what we promised, and shipping it anyway
      // would be shipping a corrupt export.
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
      for (const entry of entries) {
        // `date` is pinned to the job's generation time so the same job always
        // yields a byte-identical zip.
        archive.append(entry.content, { name: entry.name, date: modifiedAt });
      }
      // `finalize` rejects with the same error already delivered to the
      // `error` handler; `fail` is idempotent, and catching keeps it off the
      // unhandled-rejection path.
      archive.finalize().catch(fail);
    });
  }

  @Post('dsar')
  submitDsar(@CurrentUser() user: CurrentUserData, @Body() dto: SubmitDsarDto) {
    return this.accountService.submitDsar(user.userId, dto);
  }

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

  @Get('sessions')
  listSessions(@CurrentUser() user: CurrentUserData, @Req() req: Request) {
    return this.accountService.listSessions(
      user.userId,
      this.presentingRefreshToken(req),
    );
  }

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

  @Get('email-preferences')
  getEmailPreferences(@CurrentUser() user: CurrentUserData) {
    return this.accountService.getEmailPreferences(user.userId);
  }

  @Post('email-preferences')
  updateEmailPreference(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateEmailPreferenceDto,
  ) {
    return this.accountService.updateEmailPreference(user.userId, body);
  }
}

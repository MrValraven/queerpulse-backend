import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { AccountService } from './account.service';
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
  @Get('export/:jobId/download')
  async downloadExport(
    @CurrentUser() user: CurrentUserData,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { filename, body } = await this.accountService.getExportDownload(
      user.userId,
      jobId,
    );
    res.set({
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(body.byteLength),
      // The archive is the member's own personal data — never let a proxy or
      // the browser cache keep a copy after the link expires.
      'Cache-Control': 'no-store',
    });
    return new StreamableFile(body);
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

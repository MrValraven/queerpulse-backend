import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { seconds, Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { JoinRequestStatusQuery } from './dto/join-request-status.query';
import { RefreshJoinRequestInviteDto } from './dto/refresh-join-request-invite.dto';
import { PublicJoinRequestStatusView } from './join-request-response';
import { JoinRequestsService } from './join-requests.service';
import {
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

/**
 * The PUBLIC side of invite requests, after filing: one route where an
 * applicant comes back to find out what happened, and one where they revive
 * the invite an approval handed them after it lapsed.
 *
 * Filing itself lives at `POST /auth/email-code/join-request/request` and
 * `POST /auth/email-code/join-request/verify` (`EmailCodeController`, SEC-10):
 * the applicant confirms the address with a 6-digit email code before any
 * request is filed in its name. Those routes sit under `/auth` because the
 * requester cookie that binds a code to the browser that asked for it is
 * scoped to that path, and `EmailCodeService` lives in `AuthModule`, which
 * imports this module.
 *
 * The moderator/admin review queue that used to share this class now lives in
 * `AdminJoinRequestsController`, guarded at class level. Keeping the two apart
 * means a route added here is public only because someone put `@Public()` on
 * it.
 */
@ApiTags('Membership')
@Controller('join-requests')
export class JoinRequestsController {
  constructor(private readonly joinRequestsService: JoinRequestsService) {}

  /**
   * PUBLIC: an applicant checks their own request with the status token they
   * were handed in the 201 body of `POST /auth/email-code/join-request/verify`.
   * That token is the entire credential: there is no account to sign in to,
   * and the platform emails no decision, so this route plus the token the
   * applicant kept is the only way they ever learn they were approved,
   * declined, or still under review.
   *
   * Throttled 20/hour. The global `HttpThrottlerGuard` keys anonymous requests
   * by client IP (and signed-in ones by member). The token carries 256 bits,
   * so throttling is not what makes guessing infeasible; it is here so an
   * unauthenticated read that touches the database is not free amplification.
   * It is looser than the 10/hour on filing because reloading a status page
   * is a normal thing for one applicant to do repeatedly.
   *
   * ONE 404 FOR EVERY FAILURE — unknown token, well-formed token that was
   * never issued, no such request — exactly as `CardVerificationController`
   * answers. A response that distinguished "this token does not exist" from
   * anything else would make the route an oracle for probing tokens. A
   * malformed token never reaches the service: the DTO's charset and length
   * bounds turn it into a 400 first.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: seconds(3600) } })
  @Get('status')
  @ApiOperation({ summary: 'Check the status of your own invite request' })
  @ApiOkResponse({ description: 'The outcome of the invite request.' })
  @ApiNotFoundResponse({
    description: 'The token does not resolve to an invite request.',
  })
  async status(
    @Query() query: JoinRequestStatusQuery,
  ): Promise<PublicJoinRequestStatusView> {
    const view = await this.joinRequestsService.getPublicStatus(query.token);
    if (!view) {
      throw new NotFoundException('Invite request not found');
    }
    return view;
  }

  /**
   * PUBLIC: an approved applicant whose invite lapsed asks for a fresh window
   * on it (PRD-02). The token in the body is the entire credential, exactly as
   * on the read above.
   *
   * This route exists because approval used to be able to expire into a dead
   * end. QueerPulse sends the applicant nothing, so an approval reaches them
   * only when they come back and look; if they came back after the window had
   * closed, the page told them their invite was gone and offered no way to get
   * another. Now the window starts when they first read the code, and if it
   * still runs out this puts the recovery in the applicant's own hands.
   *
   * `@Public()` opts out of `JwtAuthGuard` only. The global `CsrfGuard` still
   * applies to this POST, as it does to the other public POSTs
   * (`/auth/refresh`, `/auth/logout`, the join-request code routes).
   *
   * Throttled 5/hour, keyed by IP for these anonymous callers like the read
   * above: tighter than the 20/hour status read because this one writes, and
   * there is no legitimate reason to need it more than a handful of times.
   * The refresh is separately capped per request in the service, so a leaked
   * token meets that cap as well as this throttle before it could renew an
   * invite endlessly.
   *
   * ONE 404 FOR AN UNRESOLVABLE TOKEN, identical to the read's, so this route
   * cannot be used to probe tokens either. Every 409 below is reachable only
   * by a caller that already resolved one.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: seconds(3600) } })
  @Post('status/invite/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh your own lapsed approval invite' })
  @ApiOkResponse({ description: 'The invite request, with a live invite.' })
  @ApiNotFoundResponse({
    description: 'The token does not resolve to an invite request.',
  })
  @ApiConflictResponse({
    description:
      'The invite was already used or revoked, or has been refreshed as many times as it can be.',
  })
  async refreshInvite(
    @Body() dto: RefreshJoinRequestInviteDto,
  ): Promise<PublicJoinRequestStatusView> {
    const view = await this.joinRequestsService.refreshApprovalInvite(
      dto.token,
    );
    if (!view) {
      throw new NotFoundException('Invite request not found');
    }
    return view;
  }
}

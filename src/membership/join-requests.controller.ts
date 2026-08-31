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
import { CreateMembershipJoinRequestDto } from './dto/create-join-request.dto';
import { JoinRequestStatusQuery } from './dto/join-request-status.query';
import { RefreshJoinRequestInviteDto } from './dto/refresh-join-request-invite.dto';
import {
  PublicJoinRequestStatusView,
  SubmittedJoinRequestView,
} from './join-request-response';
import { JoinRequestsService } from './join-requests.service';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

/**
 * The PUBLIC side of invite requests: three unauthenticated routes. One where
 * a stranger asks to be let in, one where they come back to find out what
 * happened, and one where they revive the invite an approval handed them after
 * it lapsed.
 *
 * The moderator/admin review queue that used to share this class now lives in
 * `AdminJoinRequestsController`, guarded at class level. Keeping the two apart
 * means a route added here is public because someone put `@Public()` on it, not
 * because they forgot the guards.
 */
@ApiTags('Membership')
@Controller('join-requests')
export class JoinRequestsController {
  constructor(private readonly joinRequestsService: JoinRequestsService) {}

  /**
   * PUBLIC: a stranger with no account asks for an invite. `@Public()` opts out
   * of `JwtAuthGuard` only — the global `CsrfGuard` still applies to this POST,
   * so the frontend must carry a CSRF token here exactly as it does for the
   * other public POSTs (`/auth/refresh`, `/auth/logout`).
   *
   * Throttled 3/hour, keyed BY IP: `HttpThrottlerGuard` (src/security) does not
   * override `getTracker`, so it inherits `ThrottlerGuard`'s default tracker,
   * which is the client IP (`req.ips[0] ?? req.ip`). That is the right key for
   * an unauthenticated route — there is no user to key on. Contrast
   * `UserPresignThrottlerGuard`, which exists precisely because it had to
   * override that default in order to track by user id instead.
   *
   * IP throttling is one of three spam controls and the weakest of them (shared
   * NAT lumps people together; an attacker can hop addresses). The other two do
   * not depend on the network: one open request per email, enforced by a partial
   * unique index, and a hard length cap on every field in the DTO.
   */
  @Public()
  @Throttle({ default: { limit: 3, ttl: seconds(3600) } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a public invite request' })
  @ApiCreatedResponse({ description: 'The invite request was recorded.' })
  @ApiForbiddenResponse({
    description: 'Invite requests are closed, or the applicant is under 18.',
  })
  @ApiConflictResponse({
    description: 'An invite request for this email is already awaiting review.',
  })
  submit(
    @Body() dto: CreateMembershipJoinRequestDto,
  ): Promise<SubmittedJoinRequestView> {
    return this.joinRequestsService.submit(dto);
  }

  /**
   * PUBLIC: an applicant checks their own request with the status token they
   * were handed in the 201 body of `POST /join-requests`. That token is the
   * entire credential — there is no account to sign in to, and the platform
   * sends no mail, so this route plus the token the applicant kept is the only
   * way they ever learn they were approved, declined, or still under review.
   *
   * Throttled 20/hour, keyed by IP through the same default tracker `submit`
   * above relies on. The token carries 256 bits, so throttling is not what
   * makes guessing infeasible; it is here so an unauthenticated read that
   * touches the database is not free amplification. It is looser than the
   * 3/hour on submission because reloading a status page is a normal thing for
   * one applicant to do repeatedly.
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
   * still runs out this puts the recovery in their own hands rather than
   * requiring a moderator to notice.
   *
   * `@Public()` opts out of `JwtAuthGuard` only. The global `CsrfGuard` still
   * applies to this POST, as it does to `submit` above and to the other public
   * POSTs (`/auth/refresh`, `/auth/logout`).
   *
   * Throttled 5/hour by IP, through the same default tracker the two routes
   * above rely on: tighter than the 20/hour status read because this one
   * writes, and there is no legitimate reason to need it more than a handful of
   * times. The refresh is separately capped per request in the service, so the
   * throttle is not the only thing standing between a leaked token and an
   * endlessly renewable invite.
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

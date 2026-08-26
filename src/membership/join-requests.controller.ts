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
 * The PUBLIC side of invite requests: two unauthenticated routes — one where a
 * stranger asks to be let in, and one where they come back to find out what
 * happened.
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
}

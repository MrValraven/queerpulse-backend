import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { seconds, Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { SubmittedJoinRequestView } from './join-request-response';
import { JoinRequestsService } from './join-requests.service';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

/**
 * The PUBLIC side of invite requests: one unauthenticated route where a
 * stranger asks to be let in.
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
  submit(@Body() dto: CreateJoinRequestDto): Promise<SubmittedJoinRequestView> {
    return this.joinRequestsService.submit(dto);
  }
}

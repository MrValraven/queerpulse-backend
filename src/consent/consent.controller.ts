import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { CURRENT_POLICY_VERSION } from './consent.constants';
import { ConsentService } from './consent.service';
import {
  PolicyAcceptanceDTO,
  PolicyAcceptanceService,
} from './policy-acceptance.service';
import { ConsentDto } from './dto/consent.dto';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// No ActiveMemberGuard: consent is captured during signup, before a user is
// promoted to `active` — a pending user must still be able to record it.
@ApiTags('Consent')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Requires an authenticated session.' })
@Controller('consent')
export class ConsentController {
  constructor(
    private readonly consentService: ConsentService,
    private readonly policyAcceptanceService: PolicyAcceptanceService,
  ) {}

  // Append a consent record; returns the stored `ConsentRecord`.
  // Throttled: the table is append-only by design, so an unthrottled caller
  // could grow it without bound. `record()` also de-duplicates an unchanged
  // decision, so a banner that re-posts the same choice costs nothing.
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post()
  @ApiOperation({ summary: 'Record a consent decision (append-only).' })
  @ApiCreatedResponse({ description: 'The stored consent record.' })
  record(@CurrentUser() user: CurrentUserData, @Body() dto: ConsentDto) {
    return this.consentService.record(user.userId, dto);
  }

  // The caller's current effective consent (`MyConsentResponse`).
  @Get('me')
  @ApiOperation({ summary: 'Get your current effective consent.' })
  @ApiOkResponse({ description: 'The caller current effective consent.' })
  me(@CurrentUser() user: CurrentUserData) {
    return this.consentService.myConsent(user.userId, CURRENT_POLICY_VERSION);
  }

  /**
   * The member has just agreed to the Terms + Community Guidelines revisions
   * currently in effect, in the re-acceptance sheet (ID-14).
   *
   * Takes NO BODY on purpose: the server stamps its own
   * `CURRENT_TERMS_VERSION` / `CURRENT_GUIDELINES_VERSION` (see
   * `PolicyAcceptanceService.accept`), so a client can never mark itself up to
   * date against a revision that was never published.
   *
   * Throttled like `POST /consent` for the same reason — the evidence table is
   * append-only, so an unthrottled caller could grow it without bound.
   *
   * No `ActiveMemberGuard`, matching the rest of this controller: a member who
   * has not been promoted to `active` yet still has to be able to agree.
   */
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post('policy-acceptance')
  @ApiOperation({
    summary:
      'Record agreement to the Terms and Community Guidelines revisions currently in effect.',
  })
  @ApiCreatedResponse({
    description:
      'The versions stamped, and what the member had on file before.',
  })
  acceptPolicies(
    @CurrentUser() user: CurrentUserData,
  ): Promise<PolicyAcceptanceDTO> {
    return this.policyAcceptanceService.accept(user.userId);
  }
}

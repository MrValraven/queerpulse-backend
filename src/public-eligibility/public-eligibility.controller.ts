import { Controller, Get } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { PublicEligibilityService } from './public-eligibility.service';
import { PublicEligibilitySignalsDto } from './public-eligibility-response';

/**
 * The caller's own public-profile eligibility signals — always "mine", so it
 * sits under `me/` (same shape as `MeCommunitiesController`). Intentionally
 * JWT-only, NOT `ActiveMemberGuard`: a deactivated member must still be able to
 * read why they're ineligible (mirrors `PreferencesController`'s public-profile
 * endpoints). The frontend scores eligibility from these raw signals.
 *
 * No `@Feature(...)` tag: this is a safety/visibility read in the same vein as
 * `PreferencesController` (no tag) rather than a launchable product feature —
 * there is no matching key in `launchedFeatures`, and inventing one for a
 * single always-on `/me` read would be wrong per that registry's own doc
 * comment ("only user-facing product features live here").
 */
@ApiTags('Members')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('me/public-eligibility')
export class PublicEligibilityController {
  constructor(private readonly service: PublicEligibilityService) {}

  @Get()
  @ApiOperation({ summary: "The caller's public-profile eligibility signals." })
  @ApiOkResponse({ description: 'The full eligibility signal set.' })
  getSignals(
    @CurrentUser() user: CurrentUserData,
  ): Promise<PublicEligibilitySignalsDto> {
    return this.service.getSignals(user);
  }
}

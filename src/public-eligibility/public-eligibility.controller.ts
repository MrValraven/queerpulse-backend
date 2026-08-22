import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { UserStatus } from '../users/entities/user.entity';
import { PublicEligibilityService } from './public-eligibility.service';
import { PublicEligibilitySignalsDto } from './public-eligibility-response';

/**
 * Rejects a suspended session, and only a suspended one.
 *
 * Narrower than `ActiveMemberGuard` (which requires `status === active` and so
 * also shuts out the deactivated members this controller is built for) and
 * unrelated to `NotRestrictedGuard` (which gates writes on an active
 * `ModActionCode.restrict`, not on account status). Local to this controller
 * because this is the only route in the codebase that wants exactly this
 * carve-out; promote it to `src/auth/guards` if a second one appears.
 */
@Injectable()
export class SuspendedMemberGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUserData }>();
    if (user?.status === UserStatus.Suspended) {
      throw new ForbiddenException(
        'This is not available while your account is suspended.',
      );
    }
    return true;
  }
}

/**
 * The caller's own public-profile eligibility signals — always "mine", so it
 * sits under `me/` (same shape as `MeCommunitiesController`). Intentionally
 * JWT-only, NOT `ActiveMemberGuard`: a deactivated member must still be able to
 * read why they're ineligible (mirrors `PreferencesController`'s public-profile
 * endpoints). The frontend scores eligibility from these raw signals.
 *
 * `ActiveMemberGuard` is deliberately still NOT used here (BE-COM-37 proposed
 * it): that guard rejects every non-`active` status, deactivated members
 * included, which is precisely the case this endpoint exists to serve. The
 * real gap it named — a *suspended* session reading its own standing signals —
 * is closed by `SuspendedMemberGuard` above, which rejects only `suspended`.
 * A suspended member has no path to a public profile while the suspension
 * stands, so there is nothing here for them to act on.
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
@ApiForbiddenResponse({ description: 'The account is suspended.' })
@Controller('me/public-eligibility')
@UseGuards(SuspendedMemberGuard)
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

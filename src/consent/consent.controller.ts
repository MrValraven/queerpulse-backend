import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { CURRENT_POLICY_VERSION } from './consent.constants';
import { ConsentService } from './consent.service';
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
  constructor(private readonly consentService: ConsentService) {}

  // Append a consent record; returns the stored `ConsentRecord`.
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
}

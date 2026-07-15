import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { CURRENT_POLICY_VERSION } from './consent.constants';
import { ConsentService } from './consent.service';
import { ConsentDto } from './dto/consent.dto';

// No ActiveMemberGuard: consent is captured during signup, before a user is
// promoted to `active` — a pending user must still be able to record it.
@Controller('consent')
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}

  // Append a consent record; returns the stored `ConsentRecord`.
  @Post()
  record(@CurrentUser() user: CurrentUserData, @Body() dto: ConsentDto) {
    return this.consentService.record(user.userId, dto);
  }

  // The caller's current effective consent (`MyConsentResponse`).
  @Get('me')
  me(@CurrentUser() user: CurrentUserData) {
    return this.consentService.myConsent(user.userId, CURRENT_POLICY_VERSION);
  }
}

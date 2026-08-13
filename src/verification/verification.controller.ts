import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { SkipCsrf } from '../security/skip-csrf.decorator';
import { IdentityCallbackDto } from './dto/identity-callback.dto';
import { StartPhoneVerificationDto } from './dto/start-phone-verification.dto';
import { VerifyPhoneDto } from './dto/verify-phone.dto';
import { VerificationService } from './verification.service';

/**
 * Member-facing step-up verification. `GET /me` reports the caller's standing;
 * the phone/identity routes raise it. `identity/callback` is the provider
 * webhook seam — unauthenticated (a real provider is authenticated by its
 * signature, verified inside the provider's `parseCallback`).
 */
@ApiTags('Verification')
@ApiCookieAuth('access_token')
@Controller('verification')
@UseGuards(ActiveMemberGuard)
export class VerificationController {
  constructor(private readonly service: VerificationService) {}

  @Get('me')
  @ApiOperation({ summary: "The current member's verification standing" })
  @ApiOkResponse({ description: 'The verification status.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getMine(@CurrentUser() user: CurrentUserData) {
    return this.service.getStatus(user.userId);
  }

  @Post('phone/start')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Start a phone verification (sends an OTP)' })
  @ApiOkResponse({ description: 'The challenge was started.' })
  startPhone(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: StartPhoneVerificationDto,
  ) {
    return this.service.startPhone(user.userId, dto);
  }

  @Post('phone/verify')
  @ApiOperation({
    summary: 'Confirm the phone OTP and raise the level to phone',
  })
  @ApiOkResponse({ description: 'The updated verification status.' })
  verifyPhone(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: VerifyPhoneDto,
  ) {
    return this.service.verifyPhone(user.userId, dto);
  }

  @Post('identity/start')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start an external ID check; returns the provider redirect',
  })
  @ApiCreatedResponse({ description: 'The provider session redirect.' })
  startIdentity(@CurrentUser() user: CurrentUserData) {
    return this.service.startIdentity(user.userId);
  }

  // Provider webhook seam. No cookie/JWT: a real provider authenticates via a
  // signature verified inside `parseCallback` (hence @Public + @SkipCsrf).
  @Public()
  @SkipCsrf()
  @SkipThrottle()
  @Post('identity/callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Identity provider result callback (unauthenticated webhook seam)',
  })
  @ApiOkResponse({ description: 'The callback was accepted.' })
  identityCallback(@Body() dto: IdentityCallbackDto) {
    return this.service.handleIdentityCallback(dto);
  }
}

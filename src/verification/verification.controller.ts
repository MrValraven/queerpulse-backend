import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { SubmitVerificationRequestDto } from './dto/submit-verification-request.dto';
import { VerifyPhoneDto } from './dto/verify-phone.dto';
import {
  toVerificationRequestDTO,
  VerificationRequestDTO,
  VerificationStatusWithRequestDTO,
} from './verification-response';
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
  @ApiOkResponse({
    description: 'The verification status, plus the latest request (if any).',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async getMine(
    @CurrentUser() user: CurrentUserData,
  ): Promise<VerificationStatusWithRequestDTO> {
    const [status, latestRequest] = await Promise.all([
      this.service.getStatus(user.userId),
      this.service.latestRequestFor(user.userId),
    ]);
    return {
      ...status,
      latestRequest: latestRequest
        ? toVerificationRequestDTO(latestRequest)
        : null,
    };
  }

  @Post('requests')
  @ApiOperation({ summary: 'Submit a new manual verification request' })
  @ApiCreatedResponse({ description: 'The created request.' })
  async submitRequest(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: SubmitVerificationRequestDto,
  ): Promise<VerificationRequestDTO> {
    const request = await this.service.submitRequest(user.userId, dto);
    return toVerificationRequestDTO(request);
  }

  @Post('requests/:id/withdraw')
  @ApiOperation({ summary: 'Withdraw your own open verification request' })
  @ApiOkResponse({ description: 'The withdrawn request.' })
  async withdrawRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VerificationRequestDTO> {
    const request = await this.service.withdrawRequest(user.userId, id);
    return toVerificationRequestDTO(request);
  }

  @Post('requests/:id/appeal')
  @ApiOperation({ summary: 'Appeal a rejected verification request (once)' })
  @ApiOkResponse({ description: 'The appealed request.' })
  async appealRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VerificationRequestDTO> {
    const request = await this.service.appealRequest(user.userId, id);
    return toVerificationRequestDTO(request);
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

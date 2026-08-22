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
import { seconds, Throttle } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { SkipCsrf } from '../security/skip-csrf.decorator';
import { IdentityCallbackDto } from './dto/identity-callback.dto';
import { SubmitVerificationRequestDto } from './dto/submit-verification-request.dto';
import {
  toVerificationRequestDTO,
  VerificationRequestDTO,
  VerificationStatusWithRequestDTO,
} from './verification-response';
import { VerificationService } from './verification.service';

/**
 * Member-facing step-up verification. `GET /me` reports the caller's standing;
 * the identity routes raise it. `identity/callback` is the provider webhook
 * seam — unauthenticated (a real provider is authenticated by its signature,
 * verified inside the provider's `parseCallback`). The phone-OTP step-up
 * (`phone/start`, `phone/verify`) was removed — its only implementation was a
 * dev-only stub that logged the OTP in plaintext and was never wired to a
 * real SMS vendor. A member can still reach `phone` level through the manual
 * review path (`POST /requests` with `requestedLevel: "phone"`).
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
  //
  // The throttle exemption is GONE. It was justified by "a real provider
  // signs its callbacks", but the only provider ever bound is the dev stub,
  // which trusts the JSON as-is — so this was an unauthenticated, unthrottled
  // write path with a 404/200 oracle on `providerRef`. A real signed webhook
  // provider stays comfortably inside this budget; if a burst ever needs more,
  // raise the limit rather than removing the ceiling. `VerificationService`
  // additionally refuses to serve this route at all when the stub provider is
  // bound in production.
  @Public()
  @SkipCsrf()
  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
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

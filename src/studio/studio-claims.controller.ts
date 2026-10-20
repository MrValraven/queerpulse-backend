import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CounterStudioClaimDto } from './dto/counter-studio-claim.dto';
import { CreateStudioClaimDto } from './dto/create-studio-claim.dto';
import { ReplyStudioClaimDto } from './dto/reply-studio-claim.dto';
import { StudioCursorQuery } from './dto/studio-cursor.query';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioMyClaim, StudioOwnerClaim } from './studio-claim-response';
import { StudioClaimsService } from './studio-claims.service';
import { StudioPage } from './studio-response';
import { STUDIO_CLAIM_LIMITS } from './studio-safety.constants';

/**
 * Studio safety and moderation (spec 5.2): copyright claims, member side.
 * Filing needs the Studio grant (the "can hear it" check runs as the
 * claimant) and no restriction; reading, replying and withdrawing need only
 * an active session, so a claimant who later loses the grant can follow
 * their claim. The owner's counter-notice needs the grant and is open to
 * restricted members, like a dispute. The filing path sits under
 * `/studio/tracks/<id>/`, so `isStudioListeningRequest` already keeps it out
 * of the request log and metrics.
 */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller()
@UseGuards(ActiveMemberGuard)
export class StudioClaimsController {
  constructor(private readonly claims: StudioClaimsService) {}

  @Post('studio/tracks/:id/copyright-claims')
  @UseGuards(StudioAccessGuard, NotRestrictedGuard)
  @Throttle({
    default: {
      limit: STUDIO_CLAIM_LIMITS.filingsPerHour,
      ttl: seconds(3600),
    },
  })
  @ApiOperation({ summary: 'File a copyright claim about a track.' })
  @ApiCreatedResponse({ description: '`StudioMyClaim`.' })
  @ApiForbiddenResponse({
    description: '`studio_access_required` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiNotFoundResponse({ description: 'Track not found.' })
  @ApiConflictResponse({
    description:
      '`studio_claim_own_track`, `studio_claim_exists` or `studio_claim_limit`.',
  })
  file(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
    @Body() body: CreateStudioClaimDto,
  ): Promise<StudioMyClaim> {
    return this.claims.file(user.userId, trackId, body);
  }

  @Get('me/studio/copyright-claims')
  @ApiOperation({ summary: "The caller's copyright claims, newest first." })
  @ApiOkResponse({ description: '`StudioPage<StudioMyClaim>`.' })
  listMine(
    @CurrentUser() user: CurrentUserData,
    @Query() query: StudioCursorQuery,
  ): Promise<StudioPage<StudioMyClaim>> {
    return this.claims.listMine(user.userId, query.cursor);
  }

  @Post('me/studio/copyright-claims/:id/reply')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: seconds(300) } })
  @ApiOperation({ summary: 'Reply once to the counter-notice.' })
  @ApiOkResponse({ description: '`StudioMyClaim`.' })
  @ApiNotFoundResponse({ description: 'Claim not found.' })
  @ApiConflictResponse({
    description:
      '`studio_claim_not_countered` or `studio_claim_already_replied`.',
  })
  reply(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) claimId: string,
    @Body() body: ReplyStudioClaimDto,
  ): Promise<StudioMyClaim> {
    return this.claims.reply(user.userId, claimId, body.reply);
  }

  @Post('me/studio/copyright-claims/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: seconds(300) } })
  @ApiOperation({ summary: 'Withdraw a live claim.' })
  @ApiOkResponse({ description: '`StudioMyClaim`.' })
  @ApiNotFoundResponse({ description: 'Claim not found.' })
  @ApiConflictResponse({ description: '`studio_claim_not_live`.' })
  withdraw(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) claimId: string,
  ): Promise<StudioMyClaim> {
    return this.claims.withdraw(user.userId, claimId);
  }

  @Post('studio/copyright-claims/:id/counter')
  @UseGuards(StudioAccessGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: seconds(300) } })
  @ApiOperation({
    summary: 'Send the counter-notice to a claim on a track you run.',
  })
  @ApiOkResponse({ description: '`StudioOwnerClaim`.' })
  @ApiNotFoundResponse({ description: 'Claim not found.' })
  @ApiConflictResponse({ description: '`studio_claim_not_accepted`.' })
  counter(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) claimId: string,
    @Body() body: CounterStudioClaimDto,
  ): Promise<StudioOwnerClaim> {
    return this.claims.counter(user.userId, claimId, body.note);
  }
}

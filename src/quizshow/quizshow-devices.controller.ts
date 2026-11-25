import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle, seconds } from '@nestjs/throttler';
import { IsString, Length } from 'class-validator';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { FEATURE_NOT_AVAILABLE_MESSAGE } from '../common/feature.decorator';
import { QuizshowDevicePairingService } from './quizshow-device-pairing.service';
import { quizshowError } from './quizshow-errors';
import {
  QuizshowHelperPairingThrottlerGuard,
  QuizshowPairingClaimThrottlerGuard,
  QuizshowScreenPairingThrottlerGuard,
} from './quizshow-pairing-throttler.guards';
import { isQuizshowPlayable } from './quizshow-play-rules';
import { QuizshowSessionsService } from './quizshow-sessions.service';
import type {
  QuizshowJoinPreview,
  QuizshowPairingClaim,
  QuizshowPairingStart,
} from './quizshow.contract';

/** Every response here carries a code, a token or a join code (contract 5). */
const NO_STORE = 'no-store';

/** `POST /quizshow/device-pairings/:pairingId/claim` body. */
export class QuizshowPairingClaimDto {
  /** 32 random bytes in base64url, as `startPairing` hands it out. */
  @IsString()
  @Length(43, 43)
  pollToken!: string;
}

/**
 * Pulse Live routes for paired devices and the signed-out join card: a TV
 * starts a screen pairing and polls for its ticket, a member starts a helper
 * pairing, and anyone holding a join code reads the quiz title and status.
 *
 * The class carries no `ActiveMemberGuard` and no feature tag, so each route
 * states its own. No route here is tagged `quizshow`: a `@Public()` route
 * tagged with an early-access feature 404s for everyone, and a TV or a
 * signed-out guest holds no grant. The screen start and the join preview
 * follow `isQuizshowPlayable()` (contract 13, amends A4): they work while the
 * feature is launched or in early access and 404 only when it cannot be
 * played. The helper start is for signed-in members: a helper never needs
 * the early-access grant. The claim needs a pairing, and none exists while
 * the feature cannot be played. The global CSRF guard still covers both
 * public POSTs.
 */
@ApiTags('Pulse Live')
@Controller('quizshow')
export class QuizshowDevicesController {
  constructor(
    private readonly pairingService: QuizshowDevicePairingService,
    private readonly sessionsService: QuizshowSessionsService,
  ) {}

  @Post('device-pairings/screen')
  @Public()
  @UseGuards(QuizshowScreenPairingThrottlerGuard)
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Start pairing a screen: a code to show and a poll token.',
  })
  @ApiCreatedResponse({ description: '`QuizshowPairingStart`.' })
  @ApiNotFoundResponse({
    description: 'Pulse Live cannot be played right now.',
  })
  @ApiTooManyRequestsResponse({
    description:
      '`quizshow_pairing_rate_limited`: more than 10 screen starts from one IP in 10 minutes.',
  })
  @ApiServiceUnavailableResponse({
    description: '`quizshow_pairing_rate_limited`: no free code turned up.',
  })
  startScreenPairing(): QuizshowPairingStart {
    if (!isQuizshowPlayable()) {
      throw new NotFoundException(FEATURE_NOT_AVAILABLE_MESSAGE);
    }
    return this.pairingService.startPairing('screen', null);
  }

  @Post('device-pairings/helper')
  @UseGuards(
    ActiveMemberGuard,
    NotRestrictedGuard,
    QuizshowHelperPairingThrottlerGuard,
  )
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', NO_STORE)
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'Start pairing this phone as a helper remote: a code to show and a poll token.',
  })
  @ApiCreatedResponse({ description: '`QuizshowPairingStart`.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: '`ACCOUNT_RESTRICTED`.' })
  @ApiTooManyRequestsResponse({
    description:
      '`quizshow_pairing_rate_limited`: more than 10 helper starts from one member in 10 minutes.',
  })
  @ApiServiceUnavailableResponse({
    description: '`quizshow_pairing_rate_limited`: no free code turned up.',
  })
  startHelperPairing(
    @CurrentUser() user: CurrentUserData,
  ): QuizshowPairingStart {
    return this.pairingService.startPairing('helper', user.userId);
  }

  @Post('device-pairings/:pairingId/claim')
  @Public()
  // The claim guard carries both claim buckets and a coded 429, so the global
  // bucket and its bare 429 stay off this route.
  @SkipThrottle()
  @UseGuards(QuizshowPairingClaimThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary:
      'Poll a pairing: waiting until a host pairs it, then the device ticket until the code expires.',
  })
  @ApiOkResponse({ description: '`QuizshowPairingClaim`.' })
  @ApiNotFoundResponse({
    description:
      '`quizshow_pairing_not_found`: an unknown id, a wrong token and an expired code all answer this.',
  })
  @ApiTooManyRequestsResponse({
    description:
      '`quizshow_pairing_rate_limited`: more than 60 claims for one pairing, or 180 from one IP, in a minute.',
  })
  claimPairing(
    // A malformed id answers the same 404 as an unknown one, so a guesser
    // learns nothing from the shape of the answer.
    @Param(
      'pairingId',
      new ParseUUIDPipe({
        exceptionFactory: () => quizshowError('quizshow_pairing_not_found'),
      }),
    )
    pairingId: string,
    @Body() body: QuizshowPairingClaimDto,
  ): QuizshowPairingClaim {
    return this.pairingService.claimPairing(pairingId, body.pollToken);
  }

  @Get('join-preview/:code')
  @Public()
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Header('Cache-Control', NO_STORE)
  @Header('X-Robots-Tag', 'noindex')
  @ApiOperation({
    summary:
      'The quiz title and status behind a join code, for the signed-out join card.',
  })
  @ApiOkResponse({ description: '`QuizshowJoinPreview`.' })
  @ApiNotFoundResponse({
    description:
      '`quizshow_join_code_not_found`, or Pulse Live cannot be played right now.',
  })
  @ApiGoneResponse({ description: '`quizshow_session_finished`.' })
  @ApiTooManyRequestsResponse({
    description: 'More than 30 preview calls in a minute.',
  })
  async getJoinPreview(
    @Param('code') code: string,
  ): Promise<QuizshowJoinPreview> {
    // `joinPreview` answers the closed-feature 404 when Pulse Live cannot
    // be played, as the join does.
    const preview = await this.sessionsService.joinPreview(code);
    // A signed-out caller sees these two fields only (contract 5.1): the
    // event, the host, the player count and the 18+ flag stay members-only.
    return { quizTitle: preview.quizTitle, status: preview.status };
  }
}

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
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
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
import { QuizshowJoinDto } from './dto/quizshow-join.dto';
import { QuizshowSessionsService } from './quizshow-sessions.service';
import { QuizshowTemplatesService } from './quizshow-templates.service';
import type {
  QuizshowJoinResponse,
  QuizshowTemplateCard,
} from './quizshow.contract';

/**
 * Pulse Live routes outside one event: the published template cards, and the
 * join code lookup. Join is open to every active member, so it carries no
 * feature tag; the template cards serve hosting and stay tagged. Join checks the code and
 * the caller's eligibility only; the player row is made by `lobby:join` on the
 * socket.
 */
@ApiTags('Pulse Live')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('quizshow')
@UseGuards(ActiveMemberGuard)
export class QuizshowController {
  constructor(
    private readonly templatesService: QuizshowTemplatesService,
    private readonly sessionsService: QuizshowSessionsService,
  ) {}

  @Get('templates')
  @Feature('quizshow')
  @ApiOperation({
    summary:
      'The published template cards, without questions, answers or staff notes.',
  })
  @ApiOkResponse({ description: '`{ items: QuizshowTemplateCard[] }`.' })
  listTemplates(): Promise<{ items: QuizshowTemplateCard[] }> {
    return this.templatesService.listPublishedCards();
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Look up a join code and check the caller may play.',
  })
  @ApiOkResponse({ description: '`QuizshowJoinResponse`.' })
  @ApiNotFoundResponse({ description: '`quizshow_join_code_not_found`.' })
  @ApiGoneResponse({ description: '`quizshow_session_finished`.' })
  @ApiForbiddenResponse({
    description:
      '`quizshow_banned_from_event`, `quizshow_cannot_view_event`, `quizshow_player_removed` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiConflictResponse({
    description: '`quizshow_organiser_running` or `quizshow_session_full`.',
  })
  @ApiTooManyRequestsResponse({
    description: 'More than 20 join calls in a minute.',
  })
  join(
    @CurrentUser() user: CurrentUserData,
    @Body() body: QuizshowJoinDto,
  ): Promise<QuizshowJoinResponse> {
    return this.sessionsService.join(user, body);
  }
}

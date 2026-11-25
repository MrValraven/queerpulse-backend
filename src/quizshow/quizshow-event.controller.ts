import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import type { QuizshowWinBadgesPreview } from '../quiz-win-badges/quiz-win-badges.contract';
import { QuizshowImportDto } from './dto/quizshow-import.dto';
import { QuizshowOpenSessionDto } from './dto/quizshow-open-session.dto';
import { QuizshowQuizInputDto } from './dto/quizshow-quiz-input.dto';
import { QuizshowQuizService } from './quizshow-quiz.service';
import { QuizshowSessionsService } from './quizshow-sessions.service';
import type {
  QuizshowImportSource,
  QuizshowQuizResponse,
  QuizshowResultsResponse,
} from './quizshow.contract';

/**
 * Pulse Live routes of one event: the organisers' quiz (read, save, import,
 * import sources), opening a live session and loading the latest
 * edits into its lobby, and the kept results. Every route
 * answers 404 `quizshow_event_not_found` to a caller who cannot view the
 * event. The writes that reach other members (save, import, open, refresh) refuse a
 * restricted member; the reads and the results delete stay open so a
 * restricted organiser can still clean up.
 */
@Feature('quizshow')
@ApiTags('Pulse Live')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('events/:slug/quizshow')
@UseGuards(ActiveMemberGuard)
export class QuizshowEventController {
  constructor(
    private readonly quizService: QuizshowQuizService,
    private readonly sessionsService: QuizshowSessionsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The event quiz, for its organisers.' })
  @ApiOkResponse({
    description:
      '`QuizshowQuizResponse`; `quiz` is null before the first save.',
  })
  @ApiNotFoundResponse({ description: '`quizshow_event_not_found`.' })
  @ApiForbiddenResponse({
    description: '`quizshow_not_organiser` or `quizshow_cohost_is_playing`.',
  })
  getQuiz(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ): Promise<QuizshowQuizResponse> {
    return this.quizService.getQuiz(slug, user.userId);
  }

  @Put()
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Replace the event quiz, its rounds and questions in one save.',
  })
  @ApiOkResponse({ description: '`QuizshowQuizResponse`.' })
  @ApiNotFoundResponse({ description: '`quizshow_event_not_found`.' })
  @ApiForbiddenResponse({
    description:
      '`quizshow_not_organiser`, `quizshow_cohost_is_playing` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiConflictResponse({
    description: '`quizshow_quiz_changed`, with the stored `updatedAt`.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`quizshow_quiz_invalid` (with `problems`) or `quizshow_adults_round_needs_adults_event`.',
  })
  replaceQuiz(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() body: QuizshowQuizInputDto,
  ): Promise<QuizshowQuizResponse> {
    return this.quizService.replaceQuiz(slug, user.userId, body);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary:
      'Replace the event quiz with a published template or the quiz of another event the caller organises.',
  })
  @ApiOkResponse({ description: '`QuizshowQuizResponse`.' })
  @ApiNotFoundResponse({
    description:
      '`quizshow_event_not_found`, `quizshow_template_not_found` or `quizshow_import_source_not_found`.',
  })
  @ApiForbiddenResponse({
    description:
      '`quizshow_not_organiser`, `quizshow_cohost_is_playing` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiConflictResponse({
    description:
      'Append only: `quizshow_quiz_changed` (with `updatedAt` and `updatedByName`) when `expectedUpdatedAt` is missing or differs from the stored `updatedAt`.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`quizshow_quiz_invalid` (with `problems`), `quizshow_adults_round_needs_adults_event` or `quizshow_import_same_event`; on an append also `quizshow_import_round_not_found`, `quizshow_import_too_many_rounds`, `quizshow_import_too_many_questions` or `quizshow_import_too_many_wheels`.',
  })
  importQuiz(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() body: QuizshowImportDto,
  ): Promise<QuizshowQuizResponse> {
    return this.quizService.importQuiz(slug, user.userId, body);
  }

  @Get('import-sources')
  @ApiOperation({
    summary:
      'Events the caller organises that hold a quiz, newest first, this event left out.',
  })
  @ApiOkResponse({ description: '`{ items: QuizshowImportSource[] }`.' })
  @ApiNotFoundResponse({ description: '`quizshow_event_not_found`.' })
  @ApiForbiddenResponse({
    description: '`quizshow_not_organiser` or `quizshow_cohost_is_playing`.',
  })
  listImportSources(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ): Promise<{ items: QuizshowImportSource[] }> {
    return this.quizService.listImportSources(slug, user.userId);
  }

  @Post('sessions')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Open a live session in the lobby.' })
  @ApiCreatedResponse({
    description: '`{ sessionId, joinCode, isGuestPushSent }`.',
  })
  @ApiNotFoundResponse({
    description:
      '`quizshow_event_not_found`, `quizshow_quiz_not_found`, or `quizshow_rematch_not_found` when `rematchOfSessionId` names no finished session of this event.',
  })
  @ApiForbiddenResponse({
    description:
      '`quizshow_not_organiser`, `quizshow_cohost_is_playing` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiConflictResponse({
    description:
      '`quizshow_session_already_open` (with `sessionId` and `joinCode`), `quizshow_results_exist`, `quizshow_event_not_playable`, or `quizshow_rematch_expired` when the rematch window of 30 minutes after the end has passed.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`quizshow_quiz_incomplete` (with `problems`) or `quizshow_adults_round_needs_adults_event`.',
  })
  openSession(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() body: QuizshowOpenSessionDto,
  ): Promise<{
    sessionId: string;
    joinCode: string;
    isGuestPushSent: boolean;
  }> {
    return this.sessionsService.openSession(slug, user.userId, body);
  }

  @Post('sessions/refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary:
      'Load the latest saved quiz into the open lobby of this event (contract 6.10).',
  })
  @ApiOkResponse({
    description:
      '`{ isNoop }`; `isNoop` is true when the lobby already runs the latest save.',
  })
  @ApiNotFoundResponse({
    description:
      '`quizshow_event_not_found`, `quizshow_session_not_found` (no open session) or `quizshow_refresh_quiz_gone`.',
  })
  @ApiForbiddenResponse({
    description:
      '`quizshow_not_organiser`, `quizshow_cohost_is_playing` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiConflictResponse({
    description:
      '`quizshow_not_in_lobby` or `quizshow_refresh_adults_lobby_joined`.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`quizshow_refresh_quiz_incomplete` (with `problems`) or `quizshow_refresh_adults_mismatch`.',
  })
  refreshLobby(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ): Promise<{ isNoop: boolean }> {
    return this.sessionsService.refreshLobby(
      { kind: 'event', slug },
      user.userId,
    );
  }

  @Get('results')
  @ApiOperation({
    summary:
      'The kept results card, for organisers, going guests and the players of that session.',
  })
  @ApiOkResponse({ description: '`QuizshowResultsResponse`.' })
  @ApiNotFoundResponse({
    description: '`quizshow_event_not_found` or `quizshow_results_not_found`.',
  })
  @ApiForbiddenResponse({ description: '`quizshow_cohost_is_playing`.' })
  getResults(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ): Promise<QuizshowResultsResponse> {
    return this.sessionsService.getResults(slug, user.userId);
  }

  @Get('win-badges')
  @ApiOperation({
    summary: 'The next game badges, for the lobby "Win to earn" row.',
  })
  @ApiOkResponse({
    description:
      '`{ preview: QuizshowWinBadgesPreview | null }`; null when the next game gives no badge.',
  })
  @ApiNotFoundResponse({ description: '`quizshow_event_not_found`.' })
  getWinBadgesPreview(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ): Promise<{ preview: QuizshowWinBadgesPreview | null }> {
    return this.sessionsService.getWinBadgesPreview(slug, user.userId);
  }

  @Delete('results')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete the kept results with their players, teams, answers and votes.',
  })
  @ApiNoContentResponse({ description: 'Results deleted.' })
  @ApiNotFoundResponse({
    description: '`quizshow_event_not_found` or `quizshow_results_not_found`.',
  })
  @ApiForbiddenResponse({ description: '`quizshow_not_organiser`.' })
  deleteResults(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ): Promise<void> {
    return this.sessionsService.deleteResults(slug, user.userId);
  }
}

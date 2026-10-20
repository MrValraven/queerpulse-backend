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
import {
  QuizshowCreateGameDto,
  QuizshowGameInputDto,
  QuizshowOpenGameSessionDto,
} from './dto/quizshow-game.dto';
import { QuizshowImportDto } from './dto/quizshow-import.dto';
import { QuizshowGamesService } from './quizshow-games.service';
import {
  QuizshowOpenSessionResult,
  QuizshowSessionsService,
} from './quizshow-sessions.service';
import type {
  QuizshowGameListResponse,
  QuizshowGameResponse,
  QuizshowImportSource,
  QuizshowResultsResponse,
} from './quizshow.contract';

/**
 * Pulse Live games that belong to a member and need no event: the member's
 * games (list, create, read, save, duplicate, delete), importing into a game,
 * opening a live session and the kept results. A game that is not the
 * caller's answers 404 `quizshow_game_not_found`. The writes that reach other
 * members (create, save, duplicate, import, open) refuse a restricted member;
 * the reads and both deletes stay open so a restricted owner can clean up.
 */
@Feature('quizshow')
@ApiTags('Pulse Live')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('quizshow/games')
@UseGuards(ActiveMemberGuard)
export class QuizshowGamesController {
  constructor(
    private readonly gamesService: QuizshowGamesService,
    private readonly sessionsService: QuizshowSessionsService,
  ) {}

  @Get()
  @ApiOperation({ summary: "The caller's games, newest first." })
  @ApiOkResponse({ description: '`QuizshowGameListResponse`.' })
  listGames(
    @CurrentUser() user: CurrentUserData,
  ): Promise<QuizshowGameListResponse> {
    return this.gamesService.listGames(user.userId);
  }

  @Post()
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Create a game, blank or copied from a starter pack or a source.',
  })
  @ApiCreatedResponse({ description: '`QuizshowGameResponse`.' })
  @ApiForbiddenResponse({
    description: '`quizshow_game_limit_reached` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiNotFoundResponse({
    description:
      '`quizshow_pack_not_found` or `quizshow_import_source_not_found`.',
  })
  createGame(
    @CurrentUser() user: CurrentUserData,
    @Body() body: QuizshowCreateGameDto,
  ): Promise<QuizshowGameResponse> {
    return this.gamesService.createGame(user.userId, body);
  }

  @Get(':gameId')
  @ApiOperation({ summary: 'One game with its rounds and questions.' })
  @ApiOkResponse({ description: '`QuizshowGameResponse`.' })
  @ApiNotFoundResponse({ description: '`quizshow_game_not_found`.' })
  getGame(
    @CurrentUser() user: CurrentUserData,
    @Param('gameId') gameId: string,
  ): Promise<QuizshowGameResponse> {
    return this.gamesService.getGame(gameId, user.userId);
  }

  @Put(':gameId')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary:
      'Replace a game, its rounds, questions and 18+ switch in one save.',
  })
  @ApiOkResponse({ description: '`QuizshowGameResponse`.' })
  @ApiNotFoundResponse({ description: '`quizshow_game_not_found`.' })
  @ApiForbiddenResponse({
    description:
      '`quizshow_game_adults_rounds_need_switch` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiConflictResponse({
    description: '`quizshow_quiz_changed`, with the stored `updatedAt`.',
  })
  @ApiUnprocessableEntityResponse({
    description: '`quizshow_quiz_invalid` (with `problems`).',
  })
  replaceGame(
    @CurrentUser() user: CurrentUserData,
    @Param('gameId') gameId: string,
    @Body() body: QuizshowGameInputDto,
  ): Promise<QuizshowGameResponse> {
    return this.gamesService.replaceGame(gameId, user.userId, body);
  }

  @Delete(':gameId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a game. An open lobby ends as abandoned first, and the results go with the game.',
  })
  @ApiNoContentResponse({ description: 'Game deleted.' })
  @ApiNotFoundResponse({ description: '`quizshow_game_not_found`.' })
  deleteGame(
    @CurrentUser() user: CurrentUserData,
    @Param('gameId') gameId: string,
  ): Promise<void> {
    return this.gamesService.deleteGame(gameId, user.userId);
  }

  @Post(':gameId/duplicate')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Copy a game under the same title.' })
  @ApiCreatedResponse({ description: '`QuizshowGameResponse`.' })
  @ApiNotFoundResponse({ description: '`quizshow_game_not_found`.' })
  @ApiForbiddenResponse({
    description: '`quizshow_game_limit_reached` or `ACCOUNT_RESTRICTED`.',
  })
  duplicateGame(
    @CurrentUser() user: CurrentUserData,
    @Param('gameId') gameId: string,
  ): Promise<QuizshowGameResponse> {
    return this.gamesService.duplicateGame(gameId, user.userId);
  }

  @Post(':gameId/import')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary:
      'Replace the rounds of a game with a starter pack, an event quiz or another game of the caller.',
  })
  @ApiOkResponse({ description: '`QuizshowGameResponse`.' })
  @ApiNotFoundResponse({
    description:
      '`quizshow_game_not_found`, `quizshow_pack_not_found` or `quizshow_import_source_not_found`.',
  })
  @ApiForbiddenResponse({
    description:
      '`quizshow_game_adults_rounds_need_switch` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiUnprocessableEntityResponse({
    description: '`quizshow_quiz_invalid` (with `problems`).',
  })
  importIntoGame(
    @CurrentUser() user: CurrentUserData,
    @Param('gameId') gameId: string,
    @Body() body: QuizshowImportDto,
  ): Promise<QuizshowGameResponse> {
    return this.gamesService.importIntoGame(gameId, user.userId, body);
  }

  @Get(':gameId/import-sources')
  @ApiOperation({
    summary:
      "Events the caller organises that hold a quiz, then the caller's other games.",
  })
  @ApiOkResponse({ description: '`{ items: QuizshowImportSource[] }`.' })
  @ApiNotFoundResponse({ description: '`quizshow_game_not_found`.' })
  async listImportSources(
    @CurrentUser() user: CurrentUserData,
    @Param('gameId') gameId: string,
  ): Promise<{ items: QuizshowImportSource[] }> {
    const items = await this.gamesService.listImportSources(
      gameId,
      user.userId,
    );
    return { items };
  }

  @Post(':gameId/sessions')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Open a live session of a game in the lobby.' })
  @ApiCreatedResponse({
    description: '`{ sessionId, joinCode, isGuestPushSent }`.',
  })
  @ApiNotFoundResponse({
    description: '`quizshow_game_not_found`.',
  })
  @ApiForbiddenResponse({
    description:
      '`quizshow_game_adults_rounds_need_switch` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiConflictResponse({
    description:
      '`quizshow_session_already_open` (with `sessionId` and `joinCode`) or `quizshow_results_exist`.',
  })
  @ApiUnprocessableEntityResponse({
    description: '`quizshow_quiz_incomplete` (with `problems`).',
  })
  openSession(
    @CurrentUser() user: CurrentUserData,
    @Param('gameId') gameId: string,
    @Body() body: QuizshowOpenGameSessionDto,
  ): Promise<QuizshowOpenSessionResult> {
    return this.sessionsService.openGameSession(gameId, user.userId, body);
  }

  @Get(':gameId/results')
  @ApiOperation({ summary: 'The kept results card of the newest session.' })
  @ApiOkResponse({ description: '`QuizshowResultsResponse`.' })
  @ApiNotFoundResponse({
    description: '`quizshow_game_not_found` or `quizshow_results_not_found`.',
  })
  getResults(
    @CurrentUser() user: CurrentUserData,
    @Param('gameId') gameId: string,
  ): Promise<QuizshowResultsResponse> {
    return this.sessionsService.getGameResults(gameId, user.userId);
  }

  @Delete(':gameId/results')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete the kept results with their players, teams, answers and votes.',
  })
  @ApiNoContentResponse({ description: 'Results deleted.' })
  @ApiNotFoundResponse({
    description: '`quizshow_game_not_found` or `quizshow_results_not_found`.',
  })
  deleteResults(
    @CurrentUser() user: CurrentUserData,
    @Param('gameId') gameId: string,
  ): Promise<void> {
    return this.sessionsService.deleteGameResults(gameId, user.userId);
  }
}

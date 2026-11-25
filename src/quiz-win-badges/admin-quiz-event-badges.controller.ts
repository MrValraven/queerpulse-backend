import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import type { Paginated } from '../common/pagination';
import { UserRole } from '../users/entities/user.entity';
import {
  QuizEventBadgeSetupInputDto,
  QuizGameWinRevokeInputDto,
} from './dto/quiz-win-badges.dto';
import { QuizEventBadgesService } from './quiz-event-badges.service';
import type {
  QuizEventBadgeSetupDTO,
  QuizEventBadgeSetupSaveResponse,
  QuizEventSearchRowDTO,
  QuizGameWinRevokeResponse,
} from './quiz-win-badges.contract';

/**
 * Staff routes for the quiz badges of an event: the event search, the per game
 * badge setup and the whole game win revoke. Moderators and admins with Pulse
 * Live access only, the same rule as the quiz templates.
 */
@ApiTags('Pulse Live')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Moderators and admins with Pulse Live access only.',
})
@Controller('admin/quizshow/events')
@Feature('quizshow')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminQuizEventBadgesController {
  constructor(private readonly events: QuizEventBadgesService) {}

  @Get()
  @ApiOperation({
    summary:
      'Events that have a Pulse Live quiz, newest first, filtered by title.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Part of the event title; cut to 100 characters.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number from 1; a bad value reads as 1.',
  })
  @ApiOkResponse({ description: '`Paginated<QuizEventSearchRowDTO>`.' })
  searchEvents(
    @Query('q') query?: string,
    @Query('page') page?: string,
  ): Promise<Paginated<QuizEventSearchRowDTO>> {
    return this.events.searchEvents(query, page);
  }

  @Put(':eventId/badges')
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Replace the badges each game of an event gives, and award a newly attached badge to the live winners of a finished game.',
  })
  @ApiOkResponse({ description: '`QuizEventBadgeSetupSaveResponse`.' })
  @ApiBadRequestResponse({
    description:
      '`quiz_badge_setup_invalid`, `quiz_badge_game_number_invalid`, `quiz_badge_game_limit_reached`, `quiz_badge_slot_duplicate` or `quiz_badge_slot_limit_reached`.',
  })
  @ApiNotFoundResponse({
    description: '`quiz_badge_event_not_found` or `quiz_badge_not_found`.',
  })
  @ApiConflictResponse({
    description: '`quiz_badge_event_has_no_quiz` or `quiz_badge_archived`.',
  })
  saveEventBadges(
    @CurrentUser() user: CurrentUserData,
    @Param('eventId') eventId: string,
    @Body() body: QuizEventBadgeSetupInputDto,
  ): Promise<QuizEventBadgeSetupSaveResponse> {
    return this.events.saveSetup(user.userId, eventId, body);
  }

  @Get(':eventId/badges')
  @ApiOperation({
    summary:
      'The badge setup page of an event: game slots, finished games and their winners.',
  })
  @ApiOkResponse({ description: '`QuizEventBadgeSetupDTO`.' })
  @ApiNotFoundResponse({ description: '`quiz_badge_event_not_found`.' })
  @ApiConflictResponse({ description: '`quiz_badge_event_has_no_quiz`.' })
  getEventBadges(
    @Param('eventId') eventId: string,
  ): Promise<QuizEventBadgeSetupDTO> {
    return this.events.getSetup(eventId);
  }

  @Post(':eventId/winners/:winnerId/revoke')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Revoke one member win of one whole game with every badge that game gave them. Final, and the reason goes to the moderation log.',
  })
  @ApiOkResponse({ description: '`QuizGameWinRevokeResponse`.' })
  @ApiBadRequestResponse({
    description:
      '`quiz_badge_revoke_reason_required` or `quiz_badge_revoke_reason_too_long`.',
  })
  @ApiNotFoundResponse({
    description:
      '`quiz_badge_event_not_found` or `quiz_badge_winner_not_found`.',
  })
  @ApiConflictResponse({ description: '`quiz_badge_winner_already_revoked`.' })
  revokeWin(
    @CurrentUser() user: CurrentUserData,
    @Param('eventId') eventId: string,
    @Param('winnerId') winnerId: string,
    @Body() body: QuizGameWinRevokeInputDto,
  ): Promise<QuizGameWinRevokeResponse> {
    return this.events.revokeWinner(user.userId, eventId, winnerId, body);
  }
}

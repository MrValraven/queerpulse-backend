import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { QuizshowStaffActionDto } from './dto/quizshow-staff-action.dto';
import { QuizshowGamesService } from './quizshow-games.service';

/**
 * Staff routes for reported Pulse Live games, keyed by the reported session
 * id. They carry no feature tag so moderators can act on a report in every
 * launch state. Each action writes a moderation audit row with the reason,
 * linked to the report when `reportId` is given.
 */
@ApiTags('Pulse Live')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Moderators and admins only.' })
@Controller('admin/quizshow')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminQuizshowController {
  constructor(private readonly gamesService: QuizshowGamesService) {}

  @Post('sessions/:sessionId/end')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End the open session of a reported game as abandoned.',
  })
  @ApiNoContentResponse({
    description: 'Session ended; a game with no open session is a no-op.',
  })
  @ApiNotFoundResponse({
    description:
      '`quizshow_game_not_found`, also when `reportId` names no `quizshow_game` report about this session.',
  })
  endSession(
    @CurrentUser() user: CurrentUserData,
    @Param('sessionId') sessionId: string,
    @Body() body: QuizshowStaffActionDto,
  ): Promise<void> {
    return this.gamesService.endGameSessionAsStaff(
      user.userId,
      sessionId,
      body,
    );
  }

  @Delete('sessions/:sessionId/game')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End any open session of a reported game, then delete the game.',
  })
  @ApiNoContentResponse({ description: 'Game deleted.' })
  @ApiNotFoundResponse({
    description:
      '`quizshow_game_not_found`, also when `reportId` names no `quizshow_game` report about this session.',
  })
  deleteGame(
    @CurrentUser() user: CurrentUserData,
    @Param('sessionId') sessionId: string,
    @Body() body: QuizshowStaffActionDto,
  ): Promise<void> {
    return this.gamesService.deleteGameAsStaff(user.userId, sessionId, body);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { UserRole } from '../users/entities/user.entity';
import { QuizBadgeDefinitionInputDto } from './dto/quiz-win-badges.dto';
import { QuizBadgeLibraryService } from './quiz-badge-library.service';
import type {
  QuizBadgeDefinitionDTO,
  QuizBadgeLibraryResponse,
} from './quiz-win-badges.contract';

/**
 * Staff routes for the quiz win badge library: every badge definition with its
 * counts, and the create, edit, archive, restore and delete actions. Moderators
 * and admins with Pulse Live access only, the same rule as the quiz templates.
 */
@ApiTags('Pulse Live')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Moderators and admins with Pulse Live access only.',
})
@Controller('admin/quizshow/badges')
@Feature('quizshow')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminQuizBadgesController {
  constructor(private readonly library: QuizBadgeLibraryService) {}

  @Get()
  @ApiOperation({
    summary: 'Every quiz badge with its counts, live ones first.',
  })
  @ApiOkResponse({ description: '`QuizBadgeLibraryResponse`.' })
  listBadges(): Promise<QuizBadgeLibraryResponse> {
    return this.library.listLibrary();
  }

  @Post()
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Create a quiz badge. Every field is required.' })
  @ApiCreatedResponse({ description: '`QuizBadgeDefinitionDTO`.' })
  @ApiBadRequestResponse({
    description:
      '`quiz_badge_text_invalid`, `quiz_badge_name_required`, `quiz_badge_name_too_long`, `quiz_badge_description_required`, `quiz_badge_description_too_long`, `quiz_badge_icon_unknown`, `quiz_badge_tint_unknown` or `quiz_badge_rarity_unknown`.',
  })
  @ApiConflictResponse({ description: '`quiz_badge_name_taken`.' })
  createBadge(
    @CurrentUser() user: CurrentUserData,
    @Body() body: QuizBadgeDefinitionInputDto,
  ): Promise<QuizBadgeDefinitionDTO> {
    return this.library.create(user.userId, body);
  }

  @Patch(':definitionId')
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Edit any subset of a quiz badge. The change reaches every holder and writes no audit row.',
  })
  @ApiOkResponse({ description: '`QuizBadgeDefinitionDTO`.' })
  @ApiBadRequestResponse({
    description:
      'The create codes: `quiz_badge_text_invalid`, `quiz_badge_name_required`, `quiz_badge_name_too_long`, `quiz_badge_description_required`, `quiz_badge_description_too_long`, `quiz_badge_icon_unknown`, `quiz_badge_tint_unknown` or `quiz_badge_rarity_unknown`.',
  })
  @ApiNotFoundResponse({ description: '`quiz_badge_not_found`.' })
  @ApiConflictResponse({ description: '`quiz_badge_name_taken`.' })
  updateBadge(
    @Param('definitionId') definitionId: string,
    @Body() body: QuizBadgeDefinitionInputDto,
  ): Promise<QuizBadgeDefinitionDTO> {
    return this.library.update(definitionId, body);
  }

  @Post(':definitionId/archive')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Archive a quiz badge. Games that already give it keep awarding it; an archived badge is a 200 no-op.',
  })
  @ApiOkResponse({ description: '`QuizBadgeDefinitionDTO`.' })
  @ApiNotFoundResponse({ description: '`quiz_badge_not_found`.' })
  archiveBadge(
    @CurrentUser() user: CurrentUserData,
    @Param('definitionId') definitionId: string,
  ): Promise<QuizBadgeDefinitionDTO> {
    return this.library.archive(user.userId, definitionId);
  }

  @Post(':definitionId/restore')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Restore an archived quiz badge. A live badge is a 200 no-op.',
  })
  @ApiOkResponse({ description: '`QuizBadgeDefinitionDTO`.' })
  @ApiNotFoundResponse({ description: '`quiz_badge_not_found`.' })
  restoreBadge(
    @CurrentUser() user: CurrentUserData,
    @Param('definitionId') definitionId: string,
  ): Promise<QuizBadgeDefinitionDTO> {
    return this.library.restore(user.userId, definitionId);
  }

  @Delete(':definitionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Delete a quiz badge nobody has won, with its slots on every event.',
  })
  @ApiNoContentResponse({ description: 'The badge and its slots are gone.' })
  @ApiNotFoundResponse({ description: '`quiz_badge_not_found`.' })
  @ApiConflictResponse({
    description: '`quiz_badge_in_use` (with `holderCount`).',
  })
  deleteBadge(
    @CurrentUser() user: CurrentUserData,
    @Param('definitionId') definitionId: string,
  ): Promise<void> {
    return this.library.remove(user.userId, definitionId);
  }
}

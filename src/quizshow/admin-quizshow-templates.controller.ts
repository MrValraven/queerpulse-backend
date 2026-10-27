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
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { QuizshowTemplateInputDto } from './dto/quizshow-template.dto';
import { QuizshowTemplatesService } from './quizshow-templates.service';
import type {
  QuizshowTemplateDetail,
  QuizshowTemplateRow,
} from './quizshow.contract';

/**
 * Staff routes for Pulse Live templates: the drafts and published quizzes
 * hosts import from. Moderators and admins with Pulse Live access manage every
 * template. Staff notes and staff display names stay on these routes.
 */
@ApiTags('Pulse Live')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Moderators and admins with Pulse Live access only.',
})
@Controller('admin/quizshow/templates')
@Feature('quizshow')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminQuizshowTemplatesController {
  constructor(private readonly templatesService: QuizshowTemplatesService) {}

  @Get()
  @ApiOperation({
    summary: 'Every template, drafts and published, newest edit first.',
  })
  @ApiOkResponse({ description: '`{ items: QuizshowTemplateRow[] }`.' })
  listTemplates(): Promise<{ items: QuizshowTemplateRow[] }> {
    return this.templatesService.listTemplateRows();
  }

  @Post()
  @ApiOperation({ summary: 'Create a draft template with a blank quiz.' })
  @ApiCreatedResponse({ description: '`QuizshowTemplateDetail`.' })
  createTemplate(
    @CurrentUser() user: CurrentUserData,
  ): Promise<QuizshowTemplateDetail> {
    return this.templatesService.createTemplate(user.userId);
  }

  @Post(':templateId/duplicate')
  @ApiOperation({
    summary: 'Copy a template into a new draft with a suffixed card title.',
  })
  @ApiCreatedResponse({ description: '`QuizshowTemplateDetail` of the copy.' })
  @ApiNotFoundResponse({ description: '`quizshow_template_not_found`.' })
  duplicateTemplate(
    @CurrentUser() user: CurrentUserData,
    @Param('templateId') templateId: string,
  ): Promise<QuizshowTemplateDetail> {
    return this.templatesService.duplicateTemplate(templateId, user.userId);
  }

  @Get(':templateId')
  @ApiOperation({
    summary: 'One template with its card, staff notes and full quiz.',
  })
  @ApiOkResponse({ description: '`QuizshowTemplateDetail`.' })
  @ApiNotFoundResponse({ description: '`quizshow_template_not_found`.' })
  getTemplate(
    @Param('templateId') templateId: string,
  ): Promise<QuizshowTemplateDetail> {
    return this.templatesService.getTemplate(templateId);
  }

  @Put(':templateId')
  @ApiOperation({
    summary:
      'Save the card, the staff notes and the quiz of a template in one write.',
  })
  @ApiOkResponse({ description: '`QuizshowTemplateDetail`.' })
  @ApiNotFoundResponse({ description: '`quizshow_template_not_found`.' })
  @ApiConflictResponse({
    description:
      '`quizshow_quiz_changed` (with the current `updatedAt`) when `quiz.expectedUpdatedAt` is stale.',
  })
  @ApiUnprocessableEntityResponse({
    description: '`quizshow_quiz_invalid` (with `problems`).',
  })
  replaceTemplate(
    @CurrentUser() user: CurrentUserData,
    @Param('templateId') templateId: string,
    @Body() body: QuizshowTemplateInputDto,
  ): Promise<QuizshowTemplateDetail> {
    return this.templatesService.replaceTemplate(templateId, user.userId, body);
  }

  @Post(':templateId/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish a template after checking its card and its quiz.',
  })
  @ApiOkResponse({ description: '`QuizshowTemplateDetail`.' })
  @ApiNotFoundResponse({ description: '`quizshow_template_not_found`.' })
  @ApiUnprocessableEntityResponse({
    description:
      '`quizshow_template_card_incomplete` (with `missing`) or `quizshow_quiz_invalid` (with `problems`).',
  })
  publishTemplate(
    @CurrentUser() user: CurrentUserData,
    @Param('templateId') templateId: string,
  ): Promise<QuizshowTemplateDetail> {
    return this.templatesService.publishTemplate(templateId, user.userId);
  }

  @Post(':templateId/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Return a published template to draft.' })
  @ApiOkResponse({ description: '`QuizshowTemplateDetail`.' })
  @ApiNotFoundResponse({ description: '`quizshow_template_not_found`.' })
  unpublishTemplate(
    @CurrentUser() user: CurrentUserData,
    @Param('templateId') templateId: string,
  ): Promise<QuizshowTemplateDetail> {
    return this.templatesService.unpublishTemplate(templateId, user.userId);
  }

  @Delete(':templateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a template.' })
  @ApiNoContentResponse({ description: 'Template deleted.' })
  @ApiNotFoundResponse({ description: '`quizshow_template_not_found`.' })
  deleteTemplate(
    @CurrentUser() user: CurrentUserData,
    @Param('templateId') templateId: string,
  ): Promise<void> {
    return this.templatesService.deleteTemplate(templateId, user.userId);
  }
}

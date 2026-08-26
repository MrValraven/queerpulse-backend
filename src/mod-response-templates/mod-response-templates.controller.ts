import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { ListModResponseTemplatesQuery } from './dto/list-mod-response-templates.query';
import { ModResponseTemplatesService } from './mod-response-templates.service';

/**
 * The moderator-facing half: read the active response library while deciding
 * a report. Mounted under `/mod`, matching `ModerationController`'s prefix and
 * guard stack, because this is read by the same drawer that files the action.
 *
 * Read-only by design. Authoring the library is an admin responsibility
 * (`AdminModResponseTemplatesController`), so a moderator cannot quietly
 * reshape the words the whole team sends out.
 */
@ApiTags('Admin — Moderation')
@ApiCookieAuth()
@Controller('mod/response-templates')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class ModResponseTemplatesController {
  constructor(
    private readonly modResponseTemplates: ModResponseTemplatesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List active moderator response templates for a decision',
  })
  @ApiOkResponse({
    description:
      'Active templates matching the reason/action filters, in display order.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  list(@Query() query: ListModResponseTemplatesQuery) {
    return this.modResponseTemplates.listActive({
      reasonCode: query.reasonCode,
      actionCode: query.actionCode,
    });
  }
}

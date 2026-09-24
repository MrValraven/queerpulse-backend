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
import { ListEmailTemplatesQuery } from './dto/list-email-templates.query';
import { EmailTemplatesService } from './email-templates.service';

/**
 * Read-only access for the people who review invite requests (moderators and
 * admins), so the approved card can copy a filled-in welcome email.
 */
@ApiTags('Admin: Email templates')
@ApiCookieAuth()
@Controller('mod/email-templates')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class EmailTemplatesController {
  constructor(private readonly emailTemplates: EmailTemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'List active email templates for one purpose' })
  @ApiOkResponse({ description: 'Active templates in display order.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  list(@Query() query: ListEmailTemplatesQuery) {
    return this.emailTemplates.listActive(query.purpose);
  }
}

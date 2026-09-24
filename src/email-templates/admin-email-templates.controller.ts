import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { CreateEmailTemplateDto } from './dto/create-email-template.dto';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
import { EmailTemplatesService } from './email-templates.service';

/**
 * Authoring for the email template library. Admin only: these are the words the
 * whole team sends, so a moderator can read and copy them but not reshape them.
 */
@ApiTags('Admin: Email templates')
@ApiCookieAuth()
@Controller('admin/email-templates')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiUnauthorizedResponse({ description: 'Authentication is required.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
export class AdminEmailTemplatesController {
  constructor(private readonly emailTemplates: EmailTemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'List every email template, active or not' })
  @ApiOkResponse({ description: 'Every template, grouped by purpose.' })
  list() {
    return this.emailTemplates.listAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one email template for the editor' })
  @ApiOkResponse({ description: 'The template.' })
  @ApiNotFoundResponse({ description: 'The template does not exist.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.emailTemplates.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create an email template' })
  @ApiCreatedResponse({ description: 'The created template.' })
  @ApiBadRequestResponse({ description: 'The content failed validation.' })
  @ApiConflictResponse({ description: 'The name is taken.' })
  create(
    @Body() dto: CreateEmailTemplateDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.emailTemplates.create(dto, user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an email template' })
  @ApiOkResponse({ description: 'The updated template.' })
  @ApiBadRequestResponse({ description: 'The content failed validation.' })
  @ApiNotFoundResponse({ description: 'The template does not exist.' })
  @ApiConflictResponse({ description: 'The name is taken.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmailTemplateDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.emailTemplates.update(id, dto, user.userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an email template' })
  @ApiNoContentResponse({ description: 'The template was deleted.' })
  @ApiNotFoundResponse({ description: 'The template does not exist.' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.emailTemplates.remove(id);
  }
}

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
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { CreateModResponseTemplateDto } from './dto/create-mod-response-template.dto';
import { ReorderModResponseTemplatesDto } from './dto/reorder-mod-response-templates.dto';
import { UpdateModResponseTemplateDto } from './dto/update-mod-response-template.dto';
import { ModResponseTemplatesService } from './mod-response-templates.service';

/**
 * Guarded CRUD for the moderator response library, in this codebase's
 * convention of a dedicated `Admin*Controller` for the authoring surface.
 *
 * Gated at the moderator/admin tier (there is no Editor role), matching
 * `ModerationController`: the people who send these notes are the people who
 * know which wording actually lands.
 */
@ApiTags('Admin — Moderation')
@ApiCookieAuth()
@Controller('admin/mod-response-templates')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiUnauthorizedResponse({ description: 'Authentication is required.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
export class AdminModResponseTemplatesController {
  constructor(
    private readonly modResponseTemplates: ModResponseTemplatesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List every response template, active or not' })
  @ApiOkResponse({ description: 'Every template in display order.' })
  list() {
    return this.modResponseTemplates.listAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a response template' })
  @ApiCreatedResponse({ description: 'The created template.' })
  @ApiBadRequestResponse({ description: 'The body uses an unknown {token}.' })
  create(
    @Body() dto: CreateModResponseTemplateDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.modResponseTemplates.create(dto, user.userId);
  }

  // Registered before `:id` so the literal `order` path is never swallowed by
  // the param route (the routing pitfall `ModerationController` guards the
  // same way for `reports/audit`).
  @Put('order')
  @ApiOperation({ summary: 'Rewrite the display order of every template' })
  @ApiOkResponse({ description: 'Every template in its new order.' })
  @ApiNotFoundResponse({ description: 'One or more ids no longer exist.' })
  reorder(@Body() dto: ReorderModResponseTemplatesDto) {
    return this.modResponseTemplates.reorder(dto.ids);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a response template' })
  @ApiOkResponse({ description: 'The updated template.' })
  @ApiBadRequestResponse({ description: 'The body uses an unknown {token}.' })
  @ApiNotFoundResponse({ description: 'The template does not exist.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateModResponseTemplateDto,
  ) {
    return this.modResponseTemplates.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a response template' })
  @ApiNoContentResponse({ description: 'The template was deleted.' })
  @ApiNotFoundResponse({ description: 'The template does not exist.' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.modResponseTemplates.remove(id);
  }
}

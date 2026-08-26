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
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminTopicsService } from './admin-topics.service';
import { CreateTopicDto } from './dto/create-topic.dto';
import { UpdateTopicDto } from './dto/update-topic.dto';

/**
 * Guarded CRUD for the topic directory (SOC-01), in this codebase's convention
 * of a dedicated `Admin*Controller` in its own `admin-*` module for an
 * authoring surface.
 *
 * Until this existed the only topics that could ever exist were whatever a
 * migration inserted, so the interest graph was frozen at whatever the
 * platform shipped with. Gated at the moderator/admin tier (there is no Editor
 * role), matching `AdminModResponseTemplatesController`: curating what the
 * community talks about is moderation work.
 *
 *   GET    /admin/topics             -> AdminTopicResponse[]  (archived included)
 *   POST   /admin/topics             -> AdminTopicResponse
 *   PATCH  /admin/topics/:id         -> AdminTopicResponse
 *   POST   /admin/topics/:id/archive -> AdminTopicResponse
 *   POST   /admin/topics/:id/restore -> AdminTopicResponse
 *   DELETE /admin/topics/:id         -> 204
 */
@ApiTags('Admin — Topics')
@ApiCookieAuth('access_token')
@Controller('admin/topics')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles('communities')
@ApiUnauthorizedResponse({ description: 'Authentication is required.' })
@ApiForbiddenResponse({
  description:
    'Requires a moderator or admin role, or the `communities` staff role.',
})
export class AdminTopicsController {
  constructor(private readonly adminTopics: AdminTopicsService) {}

  @Get()
  @ApiOperation({ summary: 'List every topic, archived ones included.' })
  @ApiOkResponse({ description: 'The full topic directory.' })
  list() {
    return this.adminTopics.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a topic.' })
  @ApiCreatedResponse({ description: 'The created topic.' })
  @ApiBadRequestResponse({
    description: 'Malformed tag, label or description.',
  })
  @ApiConflictResponse({ description: 'That tag already exists.' })
  create(@Body() dto: CreateTopicDto) {
    return this.adminTopics.create(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: "Edit a topic's label, description or crisis card.",
  })
  @ApiOkResponse({ description: 'The updated topic.' })
  @ApiBadRequestResponse({ description: 'Malformed body.' })
  @ApiNotFoundResponse({ description: 'No topic with that id.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTopicDto) {
    return this.adminTopics.update(id, dto);
  }

  @Post(':id/archive')
  @ApiOperation({
    summary:
      'Retire a topic from the directory, keeping its posts and followers.',
  })
  @ApiOkResponse({ description: 'The archived topic.' })
  @ApiNotFoundResponse({ description: 'No topic with that id.' })
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminTopics.archive(id);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Put an archived topic back in the directory.' })
  @ApiOkResponse({ description: 'The restored topic.' })
  @ApiNotFoundResponse({ description: 'No topic with that id.' })
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminTopics.restore(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Destroy a topic and its posts and follows. Prefer archive.',
  })
  @ApiNoContentResponse({ description: 'The topic is gone.' })
  @ApiNotFoundResponse({ description: 'No topic with that id.' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.adminTopics.remove(id);
  }
}

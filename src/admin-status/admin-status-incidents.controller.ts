import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { AdminStatusIncidentDTO } from './admin-status-response';
import { AdminStatusIncidentsService } from './admin-status.service';
import { CreateStatusIncidentDto } from './dto/create-status-incident.dto';
import { UpdateStatusIncidentDto } from './dto/update-status-incident.dto';

/**
 * Where an operator writes up what is going wrong, for `GET /status` to show a
 * member who cannot get in.
 *
 * `@Roles(Moderator, Admin)` rather than admin-only: an incident is often first
 * noticed by whoever is working the moderation queue at 2am, and the cost of a
 * moderator publishing a status note is far lower than the cost of nobody
 * publishing one. There is no Editor role in this codebase; this pair is the
 * staff guard.
 *
 * Deliberately NOT `@LockdownExempt()`, matching `AdminInvitesController`: the
 * authoring desk goes dark with the rest of the admin dashboard during a
 * lockdown. The PUBLIC page it feeds is exempt, so anything already published
 * stays readable throughout.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin — Status incidents')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the moderator or admin role.' })
@Controller('admin/status/incidents')
export class AdminStatusIncidentsController {
  constructor(private readonly incidents: AdminStatusIncidentsService) {}

  @ApiOperation({
    summary: 'Every status incident, newest first (resolved ones included).',
  })
  @ApiOkResponse({ type: [AdminStatusIncidentDTO] })
  @Get()
  list(): Promise<AdminStatusIncidentDTO[]> {
    return this.incidents.list();
  }

  @ApiOperation({ summary: 'Publish a new status incident.' })
  @ApiOkResponse({ type: AdminStatusIncidentDTO })
  @ApiBadRequestResponse({
    description:
      'Unknown component id, or title/body outside its length bounds.',
  })
  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateStatusIncidentDto,
  ): Promise<AdminStatusIncidentDTO> {
    return this.incidents.create(user.userId, dto);
  }

  @ApiOperation({ summary: 'Edit an incident (partial; omitted fields stay).' })
  @ApiOkResponse({ type: AdminStatusIncidentDTO })
  @ApiNotFoundResponse({ description: 'No such incident.' })
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateStatusIncidentDto,
  ): Promise<AdminStatusIncidentDTO> {
    return this.incidents.update(id, dto);
  }

  @ApiOperation({
    summary:
      'Mark an incident resolved. Idempotent: keeps the first timestamp.',
  })
  @ApiOkResponse({ type: AdminStatusIncidentDTO })
  @ApiNotFoundResponse({ description: 'No such incident.' })
  @Post(':id/resolve')
  resolve(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminStatusIncidentDTO> {
    return this.incidents.resolve(id);
  }
}

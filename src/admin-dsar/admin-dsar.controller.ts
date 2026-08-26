import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { AdminDsarRequestDTO } from './admin-dsar-response';
import { AdminDsarService } from './admin-dsar.service';
import { ListAdminDsarQuery } from './dto/list-admin-dsar.query';
import { UpdateAdminDsarDto } from './dto/update-admin-dsar.dto';

/**
 * The review queue for data-subject requests (`POST /account/dsar`): every
 * request, closest statutory deadline first, with the countdown and an overdue
 * flag on each row so the clock is visible while it runs.
 *
 * Guarded like `AdminCommunityTagRequestsController`: `ActiveMemberGuard` +
 * `RolesGuard` with `@Roles(Moderator, Admin)`, because answering a data
 * request inside the statutory window is operational work, not an
 * admin-only privilege. Deliberately NOT `@LockdownExempt()`, so it goes dark
 * with the rest of the admin dashboard.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin: data-subject requests')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the moderator or admin role.' })
@Controller('admin/dsar')
export class AdminDsarController {
  constructor(private readonly adminDsar: AdminDsarService) {}

  @ApiOperation({
    summary: 'List data-subject requests, closest deadline first (paginated).',
  })
  @ApiOkResponse({ description: 'One page of data-subject requests.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  @Get()
  list(@Query() query: ListAdminDsarQuery) {
    return this.adminDsar.list(query);
  }

  @ApiOperation({ summary: 'One data-subject request in full.' })
  @ApiOkResponse({ description: 'The data-subject request.' })
  @ApiNotFoundResponse({ description: 'No request with that id.' })
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminDsarRequestDTO> {
    return this.adminDsar.findOne(id);
  }

  @ApiOperation({
    summary: 'Move a request along and record the outcome.',
  })
  @ApiOkResponse({ description: 'The request in its new state.' })
  @ApiBadRequestResponse({
    description: 'Malformed body, or a closing move with no outcome note.',
  })
  @ApiNotFoundResponse({ description: 'No request with that id.' })
  @ApiConflictResponse({
    description: 'That status move is not available from where the request is.',
  })
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminDsarDto,
    @CurrentUser() current: CurrentUserData,
  ): Promise<AdminDsarRequestDTO> {
    return this.adminDsar.update(id, dto, current.userId);
  }
}

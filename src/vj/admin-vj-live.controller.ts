import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { vjError } from './vj.constants';
import { VjGateway, type VjLiveScope } from './vj.gateway';
import type { VjLiveDTO, VjLiveStoppedDTO } from './vj-live-response';

/** An Admin reaches every stage; a caller let in by the `vj_operator` grant
 *  alone reaches their own. The role is `users.role` as
 *  `JwtStrategy.validate` re-reads it from the database on each request,
 *  the same value `RolesOrStaffGuard` reads. */
function liveScopeOf(user: CurrentUserData): VjLiveScope {
  return {
    callerUserId: user.userId,
    isAdmin: (user.role as UserRole) === UserRole.Admin,
  };
}

/**
 * The live connections of the VJ stages: which screens and remotes are
 * attached right now, and a way to stop one of them or everything, so an idle
 * show stops holding sockets, timers and stage memory.
 *
 * Same gate as `AdminVjController`: an Admin, or a holder of the
 * `vj_operator` staff grant. An Admin sees and stops every operator's stage;
 * a caller let in by the grant alone sees and stops their own stage only.
 * The POSTs pass the global CSRF guard like every other admin write.
 *
 *   GET  admin/vj/live                              list live connections
 *   POST admin/vj/live/stop                         stop everything in scope
 *   POST admin/vj/live/connections/:connectionId/stop  stop one connection
 *
 * A stopped socket gets `exception BAD_REQUEST` with `domainCode:
 * 'vj_stopped'` and is dropped; the page turns that into a terminal refusal
 * and does not reconnect on its own.
 */
@ApiTags('Admin - VJ')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires the admin role or the vj_operator staff grant.',
})
@Controller('admin/vj/live')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('vj_operator')
export class AdminVjLiveController {
  constructor(private readonly gateway: VjGateway) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List the live VJ connections',
    description:
      'Every stage in scope with an attached screen or remote: the caller’s own stage first, then by owner name. Screens come by number with their lead flag, attach time, last fullscreen report and renderer; remotes come by the time their attach landed. `idleStageCount` counts stages held in memory with nothing attached. An Admin sees every operator’s stage; a vj_operator grant holder sees their own.',
  })
  @ApiOkResponse({ description: 'The live stages and the idle stage count.' })
  listLive(@CurrentUser() user: CurrentUserData): Promise<VjLiveDTO> {
    return this.gateway.listLiveConnections(liveScopeOf(user));
  }

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop every live VJ connection in scope',
    description:
      'Disconnects every screen and remote in scope, attached or not, with `vj_stopped`, then drops every stage in scope (attached or idle) and its timers. An Admin stops every operator’s show; a vj_operator grant holder stops their own.',
  })
  @ApiOkResponse({ description: 'How many screens and remotes were stopped.' })
  stopEverything(@CurrentUser() user: CurrentUserData): VjLiveStoppedDTO {
    return this.gateway.stopEverything(liveScopeOf(user));
  }

  @Post('connections/:connectionId/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop one live VJ connection',
    description:
      'Disconnects one screen or remote with `vj_stopped`; the stage keeps running for every other connection. Checks: `VJ_CONNECTION_NOT_FOUND`, then `VJ_CONNECTION_NOT_YOURS`.',
  })
  @ApiOkResponse({ description: 'How many screens and remotes were stopped.' })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_CONNECTION_NOT_FOUND`: no live VJ socket has that id (it already disconnected).',
  })
  @ApiForbiddenResponse({
    description:
      'Code `VJ_CONNECTION_NOT_YOURS`: a vj_operator grant holder named a connection of another operator’s stage.',
  })
  stopConnection(
    @CurrentUser() user: CurrentUserData,
    @Param('connectionId') connectionId: string,
  ): VjLiveStoppedDTO {
    const outcome = this.gateway.stopLiveConnection(
      liveScopeOf(user),
      connectionId,
    );
    if (outcome.refusal !== null) {
      throw vjError(outcome.refusal);
    }
    return outcome.stopped;
  }
}

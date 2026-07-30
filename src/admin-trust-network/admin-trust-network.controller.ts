import { Controller, Get, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminTrustNetworkService } from './admin-trust-network.service';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Read-only whole-graph trust network for admins: every member as a node,
 * every vouch (incl. withdrawn) as an edge, with derived standing + scene.
 * Not `@LockdownExempt()` — mirrors AdminMembersController.
 */
@UseGuards(RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Trust Network')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/trust-network')
export class AdminTrustNetworkController {
  constructor(private readonly service: AdminTrustNetworkService) {}

  @ApiOperation({ summary: 'Get the whole-platform trust network graph.' })
  @ApiOkResponse({ description: 'The trust network graph.' })
  @Get()
  getGraph() {
    return this.service.getGraph();
  }
}

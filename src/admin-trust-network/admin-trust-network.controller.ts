import { Controller, Get, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminTrustNetworkService } from './admin-trust-network.service';

/**
 * Read-only whole-graph trust network for admins: every member as a node,
 * every vouch (incl. withdrawn) as an edge, with derived standing + scene.
 * Not `@LockdownExempt()` — mirrors AdminMembersController.
 */
@UseGuards(RolesGuard)
@Roles(UserRole.Admin)
@Controller('admin/trust-network')
export class AdminTrustNetworkController {
  constructor(private readonly service: AdminTrustNetworkService) {}

  @Get()
  getGraph() {
    return this.service.getGraph();
  }
}

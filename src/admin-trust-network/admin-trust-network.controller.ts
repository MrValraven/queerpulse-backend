import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminTrustNetworkService } from './admin-trust-network.service';
import { GetTrustNetworkQuery } from './dto/get-trust-network.query';
import { SearchTrustNetworkMembersQuery } from './dto/search-trust-network-members.query';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Trust network for admins: up to MAX_NODES members around a focus as nodes,
 * every vouch among them (incl. withdrawn) as an edge, with derived standing,
 * scene and the platform-wide trust assessment. `getGraph`'s `focus` param and
 * the `search` route below let an admin reach any member (ADM-10); `summary`
 * feeds the members page badge. Mirrors AdminMembersController, so this
 * controller carries no `@LockdownExempt()`.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin: Trust Network')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/trust-network')
export class AdminTrustNetworkController {
  constructor(private readonly service: AdminTrustNetworkService) {}

  @ApiOperation({ summary: 'Get the whole-platform trust network graph.' })
  @ApiOkResponse({ description: 'The trust network graph.' })
  @Get()
  getGraph(@Query() query: GetTrustNetworkQuery) {
    return this.service.getGraph(query);
  }

  // Static path. This controller declares no `:id` route it could collide with.
  @ApiOperation({
    summary: 'Open trust case count and where the trust network opens.',
  })
  @ApiOkResponse({ description: 'Open case count and entry member slug.' })
  @Get('summary')
  getSummary() {
    return this.service.getSummary();
  }

  // Static path. This controller declares no `:id` route it could collide with.
  @ApiOperation({
    summary: 'Search members to locate one outside the graph node cap.',
  })
  @ApiOkResponse({ description: 'Matching members (slug, name, avatar).' })
  @Get('search')
  searchMembers(@Query() query: SearchTrustNetworkMembersQuery) {
    return this.service.searchMembers(query.q);
  }
}

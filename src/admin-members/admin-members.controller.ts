import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminMembersService } from './admin-members.service';
import { ListAdminMembersQuery } from './dto/list-admin-members.query';

/**
 * Read-only admin view over platform members: the paginated roster, the
 * flagged-members queue, and one member's full detail view.
 *
 * Deliberately NOT `@LockdownExempt()` — mirrors `AdminCommunitiesController`:
 * nothing here can lift a lockdown, so this surface should go dark with
 * everything else.
 */
@UseGuards(RolesGuard)
@Roles(UserRole.Admin)
@Controller('admin/members')
export class AdminMembersController {
  constructor(private readonly adminMembers: AdminMembersService) {}

  @Get()
  list(@Query() query: ListAdminMembersQuery) {
    return this.adminMembers.list(query);
  }

  // Declared before ':id' so 'flagged' is not captured as an id param.
  @Get('flagged')
  listFlagged() {
    return this.adminMembers.listFlagged();
  }

  @Get(':id')
  getMember(@Param('id') id: string) {
    return this.adminMembers.getMember(id);
  }
}

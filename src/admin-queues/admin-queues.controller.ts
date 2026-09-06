import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import {
  ADMIN_TRIAGE_QUEUE_CAPABILITIES,
  AdminQueuesDTO,
} from './admin-queues-response';
import { AdminQueuesService } from './admin-queues.service';

/**
 * The staff triage console's one read: what is waiting, everywhere (PRD-282).
 *
 * `RolesOrStaffGuard` rather than `RolesGuard`, and the difference matters. A
 * staff GRANT is additive on top of the account tier, so a `directory_moderator`
 * or a `resource_curator` can be a plain member by tier while owning real
 * queues. `RolesGuard` alone would have shut every one of them out of the
 * console that exists to tell them their queue is late.
 *
 * The `@StaffRoles(...)` list is SPREAD from the registry-derived
 * `ADMIN_TRIAGE_QUEUE_CAPABILITIES`, never typed out: hand-listing it would
 * silently lock out the next grant that gets a queue.
 *
 * THE GUARD IS THE OUTER GATE, NOT THE WHOLE ANSWER. Passing it only proves the
 * caller works at least one queue. Which queues they are told about is decided
 * per queue, in the response body, by `canWorkQueue` — so a moderator here
 * never learns the DSAR backlog and a `partnerships` holder never learns the
 * safe-space flag count. Narrowing only the endpoint is the mistake this repo
 * keeps a standing note about.
 *
 * Deliberately NOT `@LockdownExempt()`, mirroring `AdminOverviewController`:
 * nothing here can lift a lockdown.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles(...ADMIN_TRIAGE_QUEUE_CAPABILITIES)
@ApiTags('Admin — Queues')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires a staff tier or a queue-bearing staff grant.',
})
@Controller('admin/queues')
export class AdminQueuesController {
  constructor(private readonly adminQueues: AdminQueuesService) {}

  @ApiOperation({
    summary: 'What is waiting in every queue this caller can work.',
  })
  @ApiOkResponse({
    description:
      'Depth, oldest-waiting age and overdue count per accessible queue.',
  })
  @Get()
  getQueues(@CurrentUser() user: CurrentUserData): Promise<AdminQueuesDTO> {
    return this.adminQueues.getQueues(user);
  }
}

import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { ModerationQueueHealthService } from './moderation-queue-health.service';

/**
 * Moderator workload and SLA health, read-only (TS-04).
 *
 * MODERATORS AS WELL AS ADMINS, which is why this is `@Roles(Moderator,
 * Admin)` rather than the admin-only gate `AdminOverviewController` carries.
 * The whole point of the endpoint is that the people doing the work can see
 * how much work there is: an admin-only reading would tell the person who
 * decides the rota and not the people on it, which is the wrong way round for
 * a burnout signal.
 *
 * An EMPTY `@StaffRoles()` under `RolesOrStaffGuard`. The empty list switches
 * the grant axis off entirely, so the route falls back to its `@Roles(...)`
 * alone and no additive staff grant can reach it. That is deliberate: no grant
 * opens any of the queues measured here (`staff-roles.registry.ts` names
 * invites, join requests, verification, member bans and the report queue among
 * the surfaces reserved to the platform tier), and the numbers are about the
 * moderation rota, not about a delegated desk. Written with the explicit
 * decorator rather than by using `RolesGuard`, so that adding a grant to this
 * controller later is a visible edit rather than an accident.
 *
 * Its OWN controller rather than a method on `AdminOverviewController`: that
 * class is admin-only and this route is not, and `RolesOrStaffGuard` resolves
 * decorators per class through `getAllAndOverride`, so mixing the two gates in
 * one class would leak one onto the other.
 *
 * NOT `@LockdownExempt()`. Nothing here can lift a lockdown, matching
 * `AdminOverviewController`. A moderator working during a lockdown reaches the
 * queues themselves, which carry their own exemptions.
 *
 * There is deliberately NO member-facing counterpart to this route, and there
 * must never be one.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles()
@ApiTags('Admin — Moderation')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires the moderator or admin role. No staff grant opens this route.',
})
@Controller('admin/moderation')
export class AdminModerationHealthController {
  constructor(private readonly queueHealth: ModerationQueueHealthService) {}

  @Get('queue-health')
  @ApiOperation({
    summary:
      'Moderator workload across every queue: depth, overdue count, oldest waiting item, and the severity each crosses.',
    description:
      'One measurement per moderation queue (invite requests, reports, appeals, verification requests, ban ratifications), each with the thresholds it was judged against and a severity of ok/warning/critical, plus one overall severity and the count of active moderators the depths should be read against. Computed live on every call: one aggregate query per queue, never a query per row. The same figures are exported as Prometheus gauges on /metrics.',
  })
  @ApiOkResponse({
    description: 'The current moderation queue health picture.',
  })
  getQueueHealth() {
    return this.queueHealth.getQueueHealth();
  }
}

import { Controller, Get, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { PlatformStaffRowDTO } from './platform-staff-response';
import { PlatformStaffService } from './platform-staff.service';

// Always-on member primitive (no @Feature flag) — mirrors the FE's staff.api.ts
// exactly: `GET /platform/staff`, consumed by `useStaffRole` to badge moderators
// and admins across the app.
@Controller('platform/staff')
@UseGuards(ActiveMemberGuard)
export class PlatformStaffController {
  constructor(private readonly platformStaffService: PlatformStaffService) {}

  // Active members only. The badge is a public statement *within* the platform
  // about who runs it, but the open web does not get a scrapable roster of the
  // people holding moderation power — the frontend enforces the same rule in
  // `useStaffMap`, and this guard is what makes that more than a client-side
  // courtesy.
  @Get()
  list(): Promise<PlatformStaffRowDTO[]> {
    return this.platformStaffService.list();
  }
}

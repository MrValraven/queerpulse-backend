import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { PlatformSettingsService } from './platform-settings.service';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

/** The public projection. Deliberately narrower than the entity. */
export interface PlatformStatusView {
  registrationOpen: boolean;
  joinRequestsOpen: boolean;
  locked: boolean;
  lockdownMessage: string | null;
  registrationClosedMessage: string | null;
}

/**
 * Lets the sign-in and request-invite pages render a closed state BEFORE the
 * user submits, instead of bouncing them through Google OAuth only to reject
 * them at the callback.
 *
 * This endpoint is UX only. Every flag it reports is enforced independently at
 * its own call site, so a client that ignores this response gains nothing.
 *
 * The projection omits `updatedAt`, `updatedBy`, and everything in the audit
 * trail: an unauthenticated endpoint should not leak who operates the platform
 * or when they were last active.
 */
@Public()
@LockdownExempt()
@ApiTags('Platform Status')
@Controller('platform-status')
export class PlatformStatusController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get the public platform status projection' })
  @ApiOkResponse({
    description: 'The registration/lockdown flags and closed-state messages.',
  })
  async get(): Promise<PlatformStatusView> {
    const settings = await this.settings.get();
    return {
      registrationOpen: settings.registrationEnabled,
      joinRequestsOpen: settings.joinRequestsEnabled,
      locked: settings.lockdownEnabled,
      lockdownMessage: settings.lockdownMessage,
      registrationClosedMessage: settings.registrationClosedMessage,
    };
  }
}

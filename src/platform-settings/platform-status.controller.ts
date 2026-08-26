import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { AnnouncementDismissalService } from './announcement-dismissal.service';
import { PlatformSettingsService } from './platform-settings.service';
import {
  CURRENT_GUIDELINES_VERSION,
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from '../consent/policy-versions';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

/** The public projection. Deliberately narrower than the entity. */
export interface PlatformStatusView {
  registrationOpen: boolean;
  joinRequestsOpen: boolean;
  locked: boolean;
  lockdownMessage: string | null;
  registrationClosedMessage: string | null;
  /**
   * The community-guidelines revision currently in effect, mirroring
   * `UsersService.CURRENT_GUIDELINES_VERSION`. Exposed here so the frontend
   * onboarding wizard can read the live version instead of hardcoding its own
   * copy — see `GUIDELINES_VERSION` in `queerpulse/src/features/auth/api/auth.api.ts`,
   * which sources it from this endpoint precisely to avoid the two literals
   * drifting out of sync.
   */
  guidelinesVersion: string;
  /**
   * The Terms of Service revision currently in effect, and the Privacy Policy
   * revision cookie consent pins to. Same reason as `guidelinesVersion` above,
   * generalised (ID-14): all three now live in ONE backend file
   * (`consent/policy-versions.ts`) and the frontend reads them here rather than
   * keeping literals of its own that drift — which is exactly what had already
   * happened to the privacy version (frontend `3.4`, backend `3.3`).
   *
   * Served on this PUBLIC endpoint, not only on `/auth/me`, because the
   * surfaces that need them run with no session: the cookie banner, the
   * request-invite form's 18+ attestation, and the sign-in page.
   */
  termsVersion: string;
  privacyPolicyVersion: string;
  /**
   * Sitewide announcement banner (ADM-25). Already accounts for
   * `announcementExpiresAt` having passed — an expired announcement reports
   * `false` here even though the admin never flipped the switch off, so the
   * frontend never has to know about expiry at all.
   */
  announcementEnabled: boolean;
  /** `null` whenever `announcementEnabled` above is `false`. */
  announcementMessage: string | null;
  /** `null` whenever `announcementEnabled` above is `false`. */
  announcementVersion: string | null;
  /**
   * Whether the CALLER has already dismissed this exact version. Always
   * `false` for a signed-out visitor and for a `false` `announcementEnabled`
   * above — the frontend falls back to a `localStorage` flag (keyed by
   * `announcementVersion`) for the signed-out case.
   */
  announcementDismissed: boolean;
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
@UseGuards(OptionalJwtAuthGuard)
@ApiTags('Platform Status')
@Controller('platform-status')
export class PlatformStatusController {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly announcementDismissals: AnnouncementDismissalService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get the public platform status projection' })
  @ApiOkResponse({
    description: 'The registration/lockdown flags and closed-state messages.',
  })
  async get(
    @CurrentUser() user: CurrentUserData | undefined,
  ): Promise<PlatformStatusView> {
    const settings = await this.settings.get();

    const announcementActive =
      settings.announcementEnabled &&
      (!settings.announcementExpiresAt ||
        settings.announcementExpiresAt.getTime() > Date.now());

    const announcementDismissed =
      announcementActive && user
        ? await this.announcementDismissals.isDismissed(
            user.userId,
            settings.announcementVersion,
          )
        : false;

    return {
      registrationOpen: settings.registrationEnabled,
      joinRequestsOpen: settings.joinRequestsEnabled,
      locked: settings.lockdownEnabled,
      lockdownMessage: settings.lockdownMessage,
      registrationClosedMessage: settings.registrationClosedMessage,
      guidelinesVersion: CURRENT_GUIDELINES_VERSION,
      termsVersion: CURRENT_TERMS_VERSION,
      privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      announcementEnabled: announcementActive,
      announcementMessage: announcementActive
        ? settings.announcementMessage
        : null,
      announcementVersion: announcementActive
        ? settings.announcementVersion
        : null,
      announcementDismissed,
    };
  }
}

import { SetMetadata } from '@nestjs/common';

export const LOCKDOWN_EXEMPT_KEY = 'lockdownExempt';

/**
 * Marks a route (or a whole controller) as reachable while the platform is
 * locked down.
 *
 * This is deliberately an explicit opt-in rather than "all `@Public()` routes
 * are exempt": most public routes are public *browse* endpoints, and a
 * lockdown that leaves the catalogue readable has not locked anything. The
 * exemption list is small and security-relevant, so it should be something a
 * reviewer can enumerate by grepping this decorator.
 *
 * A lockdown that locks the admin out of the switch which ends the lockdown is
 * a self-inflicted outage — `/admin/platform-settings` and the whole auth
 * surface are exempt for that reason.
 */
export const LockdownExempt = () => SetMetadata(LOCKDOWN_EXEMPT_KEY, true);

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { UserRole } from '../users/entities/user.entity';
import { DEFAULT_LOCKDOWN_MESSAGE } from './lockdown.constants';
import { LOCKDOWN_EXEMPT_KEY } from './lockdown-exempt.decorator';

/**
 * Global guard implementing the platform kill switch.
 *
 * Registered LAST in the chain, after `JwtAuthGuard`, because it needs
 * `req.user.role` — which only exists once JWT validation has populated it.
 * `JwtStrategy.validate` re-reads role from Postgres on every request, so this
 * never trusts a stale role claim baked into an old token.
 *
 * Responds 503, not 403: the platform is temporarily unavailable rather than
 * the caller being unauthorised, and keeping the two distinguishable matters
 * both to the frontend handler and to anyone reading the logs during an
 * incident.
 */
@Injectable()
export class PlatformLockdownGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly settings: PlatformSettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // WS connections are gated in ChatGateway.handleConnection instead — there
    // is no HTTP request here to read a user off.
    if (context.getType() !== 'http') {
      return true;
    }

    const exempt = this.reflector.getAllAndOverride<boolean>(
      LOCKDOWN_EXEMPT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (exempt) {
      return true;
    }

    const settings = await this.settings.get();
    if (!settings.lockdownEnabled) {
      return true;
    }

    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUserData }>();
    const role = user?.role as UserRole | undefined;

    if (role === UserRole.Admin) {
      return true;
    }
    if (role === UserRole.Moderator && settings.lockdownAllowsModerators) {
      return true;
    }

    // `statusCode` and `error` are supplied DELIBERATELY, not redundantly: when
    // Nest is handed an object response it passes that object through to the
    // wire verbatim and does NOT inject the usual envelope fields. Dropping
    // them as "duplication" would change the response shape and break the
    // consistency every other error in this API has.
    //
    // `||`, not `??`: an admin who clears the message textarea sends `''`,
    // which is not a message. `??` would ship a blank maintenance screen.
    throw new ServiceUnavailableException({
      statusCode: 503,
      error: 'Service Unavailable',
      code: 'PLATFORM_LOCKED',
      message: settings.lockdownMessage || DEFAULT_LOCKDOWN_MESSAGE,
    });
  }
}

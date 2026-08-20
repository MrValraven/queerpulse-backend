import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { CurrentUserData } from '../decorators/current-user.decorator';

/** Machine-readable code the frontend can key a "you're restricted" prompt
 *  off, mirroring `AFFIRMING_PLEDGE_REQUIRED_CODE`'s convention. */
export const ACCOUNT_RESTRICTED_CODE = 'ACCOUNT_RESTRICTED';

/**
 * Blocks one specific write action for a member under an active moderation
 * restriction (`ModActionCode.restrict` — see
 * `AccountEnforcementService.enforceAgainstUser`).
 *
 * Deliberately narrower than {@link ActiveMemberGuard}: a restriction is not a
 * lockout. The member keeps signing in, browsing, and taking every other
 * action normally — only the handlers this guard is bound to at the METHOD
 * level (never the controller) reject them. Reads `request.user.restricted`,
 * which `JwtStrategy.validate`/`liftExpiredRestriction` already computed fresh
 * (DB-backed, lazily expired) for this request — no second query here.
 */
@Injectable()
export class NotRestrictedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUserData }>();
    if (!user?.restricted) {
      return true;
    }
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      message:
        'This action is unavailable while a moderation restriction is in effect.',
      code: ACCOUNT_RESTRICTED_CODE,
    });
  }
}

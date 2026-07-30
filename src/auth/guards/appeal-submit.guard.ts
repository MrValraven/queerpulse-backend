import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { UserStatus } from '../../users/entities/user.entity';
import { CurrentUserData } from '../decorators/current-user.decorator';

/**
 * The deliberate exception to {@link ActiveMemberGuard} for the appeal-submission
 * route, and ONLY that route.
 *
 * Every other member-facing surface is gated by `ActiveMemberGuard`, which
 * rejects anyone whose status is not `Active` — including a suspended or banned
 * member. That is correct almost everywhere, but it also locks a suspended
 * member out of the one path they most need: contesting the decision. This
 * guard opens that single door without weakening `ActiveMemberGuard` at all.
 *
 * Allowed: `Active` (a member appealing a warn / content-removal that did not
 * suspend them) and `Suspended` (a suspension or a permanent ban — a ban is a
 * `Suspended` row with a NULL `suspendedUntil`, see `User.suspendedUntil`).
 *
 * Rejected:
 *  - `Deactivated` — a member-initiated pause, not a moderation action. There
 *    is nothing to appeal; they can reactivate (the account controller is
 *    JWT-only, so reactivation is reachable) and appeal then.
 *  - A fully erased / deleted account — it has NO `users` row, so
 *    `JwtStrategy.validate` already throws `UnauthorizedException` upstream of
 *    this guard. It can never reach here to be allowed.
 */
@Injectable()
export class AppealSubmitGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUserData }>();
    if (
      user?.status === UserStatus.Active ||
      user?.status === UserStatus.Suspended
    ) {
      return true;
    }
    throw new ForbiddenException(
      'Only an account with an active moderation decision against it can file an appeal.',
    );
  }
}

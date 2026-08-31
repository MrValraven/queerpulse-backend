import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface CurrentUserData {
  userId: string;
  email: string;
  status: string;
  role: string;
  /**
   * Whether the caller is currently under an active moderation restriction
   * (`AccountEnforcementService.enforceAgainstUser`'s `restrict` action) —
   * already past `JwtStrategy.liftExpiredRestriction`'s lazy expiry, so a
   * lapsed restriction reads `false` here. Optional (rather than required) so
   * existing test fixtures that build a `CurrentUserData` literal without it
   * keep compiling; `undefined` is treated as "not restricted" everywhere it's
   * read (`NotRestrictedGuard`).
   */
  restricted?: boolean;
  /**
   * The SESSION the caller's access token was minted for: a
   * `refresh_tokens.family_id`, the same value `AccountService.listSessions`
   * hands the security page as a session id and `revokeSession` addresses.
   *
   * This is how a request knows which of the member's devices it came from.
   * Before the token carried it, the only thing naming the session was the
   * `refresh_token` cookie, which is scoped to `/auth` (see `auth-cookies.ts`)
   * and so never reaches `/account/sessions`: the security page could not flag
   * which listed device the member was holding, and "sign out my other devices"
   * matched no current session and signed out every one of them.
   *
   * Optional, for two reasons that both resolve on their own. Access tokens
   * minted before the deploy that added the `sid` claim carry none, and expire
   * within one access TTL. Test fixtures that build a `CurrentUserData` literal
   * without it keep compiling. Anything that MUST know the session has to treat
   * `undefined` as "unknown" and refuse rather than fall back to a default:
   * `AccountService.revokeOtherSessions` is the worked example.
   */
  sessionId?: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserData => {
    const request = ctx.switchToHttp().getRequest<{ user: CurrentUserData }>();
    return request.user;
  },
);

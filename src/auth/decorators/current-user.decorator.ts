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
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserData => {
    const request = ctx.switchToHttp().getRequest<{ user: CurrentUserData }>();
    return request.user;
  },
);

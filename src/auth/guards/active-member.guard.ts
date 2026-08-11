import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserStatus } from '../../users/entities/user.entity';
import { CurrentUserData } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class ActiveMemberGuard implements CanActivate {
  // `@Optional()` so the guard still constructs bare (`new ActiveMemberGuard()`)
  // in unit tests; under Nest DI the globally-provided `Reflector` is always
  // injected. Needed so this guard can be bound at the CLASS level on a
  // controller that also carries `@Public()` routes (e.g. `SubprofilesController`)
  // and correctly step aside for them — mirroring how `JwtAuthGuard` reads the
  // same `IS_PUBLIC_KEY`.
  constructor(@Optional() private readonly reflector?: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector?.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      // A `@Public()` route opts out of active-member enforcement — an
      // anonymous visitor is allowed through (the handler decides what a
      // signed-out caller may see).
      return true;
    }
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUserData }>();
    if (user?.status !== UserStatus.Active) {
      throw new ForbiddenException('Active membership required');
    }
    return true;
  }
}

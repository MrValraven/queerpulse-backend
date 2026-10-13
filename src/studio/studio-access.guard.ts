import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { StudioAccessService } from './studio-access.service';
import { studioError } from './studio.constants';

/**
 * Studio v1: passes a member holding a Studio access grant and answers
 * everyone else 403 `studio_access_required`. Bound after
 * `ActiveMemberGuard` on every Studio member route except `GET /studio/me`,
 * which answers `hasAccess: false` so the frontend can choose what to render.
 * One indexed read per request, so a revoked grant stops new requests at once.
 */
@Injectable()
export class StudioAccessGuard implements CanActivate {
  constructor(private readonly access: StudioAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUserData }>();
    if (!user || !(await this.access.hasAccess(user.userId))) {
      throw studioError('studio_access_required');
    }
    return true;
  }
}

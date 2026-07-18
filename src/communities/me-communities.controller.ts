import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CommunitiesService } from './communities.service';

/**
 * The caller's own community memberships. Split out of
 * `CommunitiesController` because the resource is always "mine" and so sits
 * under `me/`, not under `communities/:slug` — the same shape as
 * `AffiliationController` (`me/affiliation`) and `DraftsController`
 * (`me/drafts`).
 */
@Feature('communities')
@Controller('me/communities')
@UseGuards(ActiveMemberGuard)
export class MeCommunitiesController {
  constructor(private readonly communitiesService: CommunitiesService) {}

  /**
   * `GET /me/communities` — a bare array, NOT a `Paginated<T>` envelope like
   * `GET /communities`. The client needs the caller's membership map whole
   * (see `CommunitiesService.myCommunities`); paginating it is the exact bug
   * this endpoint replaces.
   */
  @Get()
  list(@CurrentUser() user: CurrentUserData) {
    return this.communitiesService.myCommunities(user.userId);
  }
}

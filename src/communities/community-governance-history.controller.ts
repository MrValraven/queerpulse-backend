import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CommunityGovernanceHistoryService } from './community-governance-history.service';
import { ListCommunityGovernanceLogQuery } from './dto/list-community-governance-log.query';
import { GovernanceLogAction } from './entities/community-governance-log.entity';

/**
 * `@Controller('communities/:slug/governance-log')` is a standalone controller
 * on a nested path, the convention this module follows for
 * `CommunityPulseController`, `CommunityInsightsController` and
 * `CommunityBansController`. See `CommunityPulseController`'s doc comment for
 * why a route under `communities/:slug` does not have to be a method on
 * `CommunitiesController`.
 *
 * The READ side only. Entries are written by `CommunityGovernanceLogService.log()`
 * from the actions themselves (role changes, removals, bans, ownership
 * transfers, freezes, archives, settings changes, card actions), and nothing
 * anywhere may create, edit or delete an entry through an endpoint. An audit
 * trail has to stay beyond the reach of its own subjects to be worth
 * consulting.
 *
 * The platform-staff reader (`GET /admin/communities/:slug/governance-log`)
 * stays exactly as it was: it reads every community and exposes the full
 * `metadata` payload. This route is scoped to one community, for that
 * community's own staff, and returns a narrowed shape. See
 * `CommunityGovernanceLogDetailsDTO` for what is withheld and why.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/governance-log')
@UseGuards(ActiveMemberGuard)
export class CommunityGovernanceHistoryController {
  constructor(
    private readonly communityGovernanceHistoryService: CommunityGovernanceHistoryService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      "This community's governance audit trail (owner, co-owner or moderator): every role change, removal, ban, ownership transfer, freeze, archive, settings change and card action, newest first.",
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '1-based page number. Defaults to 1.',
  })
  @ApiQuery({
    name: 'action',
    required: false,
    enum: GovernanceLogAction,
    description: 'Narrow the trail to a single kind of governance action.',
  })
  @ApiOkResponse({
    description:
      'A page of governance entries (`{ items, total, page, pageSize }`), newest first.',
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  list(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListCommunityGovernanceLogQuery,
  ) {
    return this.communityGovernanceHistoryService.listBySlug(
      slug,
      user.userId,
      query,
    );
  }
}

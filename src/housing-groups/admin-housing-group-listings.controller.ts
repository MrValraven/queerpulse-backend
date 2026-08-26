import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { HousingModerationGuard } from '../auth/guards/housing-moderation.guard';
import { ListGroupListingQueueQuery } from './dto/list-group-listing-queue.query';
import { SetGroupListingStatusDto } from './dto/set-group-listing-status.dto';
import { HousingGroupsService } from './housing-groups.service';

/**
 * The pre-publication review decision on a group listing (BE-HSG-01).
 *
 * Lives here rather than on `AdminHousingGroupsController` (`admin-housing/`)
 * because the review state it drives is owned by this module — the entity, its
 * enum and the risk scoring all sit under `housing-groups/`, and the admin
 * console module only ever consumed this service. Both controllers share the
 * `admin/housing-groups` prefix and the same guard pair; their route paths do
 * not overlap (`listings/:id/status` here, `listings/:id/hidden` there), so
 * Nest resolves them independently.
 *
 * The two decisions are NOT interchangeable: `status` decides whether a listing
 * ever becomes public, `hidden` takes an already-public one down for a norm
 * violation.
 */
@UseGuards(ActiveMemberGuard, HousingModerationGuard)
@ApiTags('Admin — Housing groups')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires the moderator or admin role, or the housing_moderator staff role.',
})
@Controller('admin/housing-groups')
export class AdminHousingGroupListingsController {
  constructor(private readonly groups: HousingGroupsService) {}

  // The queue itself (LOC-19). Declared BEFORE `listings/:id/status` for
  // readability only: the two paths cannot collide, since `queue` is a static
  // segment on a two-segment path and the other is three segments long.
  @ApiOperation({
    summary:
      'The paginated group-listing review queue, riskiest first (moderator only).',
  })
  @ApiOkResponse({ description: 'One page of listings awaiting a decision.' })
  @Get('listings/queue')
  listListingQueue(@Query() query: ListGroupListingQueueQuery) {
    return this.groups.listListingQueue(query);
  }

  @ApiOperation({
    summary:
      "Set a group listing's pre-publication review status (moderator only).",
  })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiBadRequestResponse({
    description: 'A declined listing, or a question, needs a reason.',
  })
  @ApiNotFoundResponse({ description: 'Listing not found.' })
  @Patch('listings/:id/status')
  setListingStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetGroupListingStatusDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.groups.setListingStatus(id, dto, user.userId);
  }
}

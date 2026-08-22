import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { HousingModerationGuard } from '../auth/guards/housing-moderation.guard';
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

  @ApiOperation({
    summary:
      "Set a group listing's pre-publication review status (moderator only).",
  })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'Listing not found.' })
  @Patch('listings/:id/status')
  setListingStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetGroupListingStatusDto,
  ) {
    return this.groups.setListingStatus(id, dto);
  }
}

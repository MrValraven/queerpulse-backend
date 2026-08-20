import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { HousingModerationGuard } from '../auth/guards/housing-moderation.guard';
import { HousingGroupsService } from '../housing-groups/housing-groups.service';
import { CreateGroupDto } from '../housing-groups/dto/create-group.dto';
import { UpdateGroupDto } from '../housing-groups/dto/update-group.dto';
import { TriageGroupJoinRequestDto } from '../housing-groups/dto/triage-group-join-request.dto';
import { HideGroupListingDto } from '../housing-groups/dto/hide-group-listing.dto';

/**
 * Steward/moderator console for vetted housing groups: manage groups, review
 * access-gated join requests, and enforce norms by hiding listings that break
 * them (hate speech, brokers, opaque pricing). Guarded — Moderators and Admins
 * (Admin here; norms review is an admin/steward duty, matching the co-op admin
 * precedent), OR a member holding the additive `housing_moderator` staff role
 * (see `HousingModerationGuard`).
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
export class AdminHousingGroupsController {
  constructor(private readonly groups: HousingGroupsService) {}

  @ApiOperation({ summary: 'List every housing group for admin management.' })
  @ApiOkResponse({ description: 'The groups.' })
  @Get()
  listGroups() {
    return this.groups.listAllForAdmin();
  }

  @ApiOperation({ summary: 'Create a housing group.' })
  @ApiCreatedResponse({ description: 'The created group.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiConflictResponse({ description: 'Slug already in use.' })
  @Post()
  createGroup(@Body() dto: CreateGroupDto) {
    return this.groups.createGroup(dto);
  }

  @ApiOperation({ summary: 'Update a housing group.' })
  @ApiOkResponse({ description: 'The updated group.' })
  @ApiNotFoundResponse({ description: 'Group not found.' })
  @ApiConflictResponse({ description: 'Slug already in use.' })
  @Patch(':id')
  updateGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.groups.updateGroup(id, dto);
  }

  @ApiOperation({ summary: 'Delete a housing group.' })
  @ApiNoContentResponse({ description: 'Group deleted.' })
  @ApiNotFoundResponse({ description: 'Group not found.' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteGroup(@Param('id', ParseUUIDPipe) id: string) {
    return this.groups.deleteGroup(id);
  }

  @ApiOperation({
    summary: 'List group join requests, optionally filtered by group slug.',
  })
  @ApiOkResponse({
    description: 'The join requests, with the mutual-connections trust signal.',
  })
  @Get('join-requests')
  listJoinRequests(@Query('group') groupSlug?: string) {
    return this.groups.listJoinRequests(groupSlug);
  }

  @ApiOperation({ summary: 'Triage (approve/decline) a group join request.' })
  @ApiOkResponse({ description: 'The updated join request.' })
  @ApiNotFoundResponse({ description: 'Join request not found.' })
  @Patch('join-requests/:id')
  triageJoinRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriageGroupJoinRequestDto,
  ) {
    return this.groups.triageJoinRequest(id, dto.action);
  }

  @ApiOperation({
    summary: 'List group listings for moderation, optionally by group slug.',
  })
  @ApiOkResponse({ description: 'The listings, including hidden ones.' })
  @Get('listings')
  listListings(@Query('group') groupSlug?: string) {
    return this.groups.listAllListingsForAdmin(groupSlug);
  }

  @ApiOperation({
    summary: 'Hide or un-hide a group listing for a norm violation.',
  })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'Listing not found.' })
  @Patch('listings/:id/hidden')
  setListingHidden(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HideGroupListingDto,
  ) {
    return this.groups.setListingHidden(id, dto);
  }
}

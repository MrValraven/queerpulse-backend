import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
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
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CommunityResourcesService } from './community-resources.service';
import { CreateCommunityResourceDto } from './dto/create-community-resource.dto';
import { ReorderCommunityResourcesDto } from './dto/reorder-community-resources.dto';
import { UpdateCommunityResourceDto } from './dto/update-community-resource.dto';

/**
 * `@Controller('communities/:slug/resources')` — a route path nested under
 * `communities/:slug`, but a standalone controller (not methods added to
 * `CommunitiesController`), the convention this module already follows for
 * `CommunityPulseController` and `CommunityInsightsController`. See the pulse
 * controller's doc comment for why Nest is happy with that.
 *
 * Reads are open to any member of the community; every write is owner,
 * co-owner or moderator. The writes carry the same `20 per 60s` per-route
 * throttle the community post/reply writes do (BE-COM-02), so a compromised
 * staff session cannot churn the shelf at the global limit.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/resources')
@UseGuards(ActiveMemberGuard)
export class CommunityResourcesController {
  constructor(
    private readonly communityResourcesService: CommunityResourcesService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      "A community's resource shelf: pinned links, documents and guides (roster members only).",
  })
  @ApiOkResponse({
    description: 'The ordered shelf, plus the per-community cap.',
  })
  @ApiForbiddenResponse({ description: 'Only roster members can do that.' })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  list(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communityResourcesService.listBySlug(slug, user.userId);
  }

  @Post()
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Pin a resource to the shelf (owner, co-owner or moderator). Appended to the end.',
  })
  @ApiCreatedResponse({ description: 'The created resource.' })
  @ApiBadRequestResponse({
    description:
      'The payload is invalid, or the URL is not an absolute http/https URL.',
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  @ApiConflictResponse({ description: 'The shelf is already at its cap.' })
  create(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateCommunityResourceDto,
  ) {
    return this.communityResourcesService.create(slug, user.userId, dto);
  }

  // Declared BEFORE `PATCH :id` on purpose: Nest matches routes in
  // declaration order, and `order` would otherwise be taken as an `:id` and
  // rejected by `ParseUUIDPipe` as a malformed uuid.
  @Patch('order')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      "Set the shelf's order (owner, co-owner or moderator). Send every resource id, once, in the order they should appear.",
  })
  @ApiOkResponse({ description: 'The reordered shelf.' })
  @ApiBadRequestResponse({
    description:
      "The id list does not match this community's shelf exactly, or repeats an id.",
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  reorder(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: ReorderCommunityResourcesDto,
  ) {
    return this.communityResourcesService.reorder(slug, user.userId, dto);
  }

  @Patch(':id')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Edit one resource (owner, co-owner or moderator).',
  })
  @ApiOkResponse({ description: 'The updated resource.' })
  @ApiBadRequestResponse({
    description:
      'Malformed resource id, invalid payload, or a URL that is not an absolute http/https URL.',
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug or resource, or an archived community.',
  })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCommunityResourceDto,
  ) {
    return this.communityResourcesService.update(slug, user.userId, id, dto);
  }

  @Delete(':id')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Take one resource off the shelf (owner, co-owner or moderator).',
  })
  @ApiOkResponse({ description: 'The resource was removed (`{ ok: true }`).' })
  @ApiBadRequestResponse({ description: 'Malformed resource id.' })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug or resource, or an archived community.',
  })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.communityResourcesService.remove(slug, user.userId, id);
  }
}

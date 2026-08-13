import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CreateGroupJoinRequestDto } from './dto/create-group-join-request.dto';
import { CreateGroupListingDto } from './dto/create-group-listing.dto';
import { HousingGroupsService } from './housing-groups.service';

/**
 * Public directory of vetted housing groups. Static segments (`listings`,
 * `join-requests`) sit under the `:slug` prefix, so route matching resolves
 * them literally.
 *
 * Join requests may be submitted by anyone — the access-gated group model
 * collects a `name` and community-relationship answer precisely so a non-member
 * can ask to be let in. `OptionalJwtAuthGuard` + `@Public()` best-effort attach
 * `req.user` WHEN a valid session cookie is present (so a signed-in member's
 * `userId` is captured for the mutual-connections trust signal) without ever
 * rejecting an anonymous applicant.
 */
@Feature('housing')
@ApiTags('Housing groups')
@Controller('housing-groups')
export class HousingGroupsController {
  constructor(private readonly groups: HousingGroupsService) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'List published vetted housing groups' })
  @ApiOkResponse({ description: 'All published groups.' })
  listGroups() {
    return this.groups.listPublished();
  }

  @Public()
  @Get(':slug')
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'Get one published group by slug' })
  @ApiOkResponse({ description: 'The group.' })
  @ApiNotFoundResponse({ description: 'No published group with that slug.' })
  getGroup(@Param('slug') slug: string) {
    return this.groups.getPublishedBySlug(slug);
  }

  @Public()
  @Get(':slug/listings')
  @Header('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120')
  @ApiOperation({ summary: "A group's visible (non-hidden) listings" })
  @ApiOkResponse({ description: 'The listings.' })
  @ApiNotFoundResponse({ description: 'No published group with that slug.' })
  listListings(@Param('slug') slug: string) {
    return this.groups.listVisibleListings(slug);
  }

  // Anonymous public write: tightly throttled per IP so the group review queue
  // can't be flooded. `@Public()` + optional guard means an anonymous applicant
  // is allowed, a signed-in one is identified.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post(':slug/join-requests')
  @ApiOperation({ summary: 'Ask to join a group (anonymous allowed)' })
  @ApiCreatedResponse({ description: 'The created join request.' })
  @ApiNotFoundResponse({ description: 'No published group with that slug.' })
  submitJoinRequest(
    @Param('slug') slug: string,
    @Body() dto: CreateGroupJoinRequestDto,
    @CurrentUser() user: CurrentUserData | undefined,
  ) {
    return this.groups.createJoinRequest(slug, dto, user?.userId ?? null);
  }

  // Sharing a listing into a group requires an active member. Norms (price +
  // accessibility transparency) are enforced by `CreateGroupListingDto`.
  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post(':slug/listings')
  @ApiOperation({ summary: 'Share a listing into a group (member only)' })
  @ApiCreatedResponse({ description: 'The created listing.' })
  @ApiNotFoundResponse({ description: 'No published group with that slug.' })
  createListing(
    @Param('slug') slug: string,
    @Body() dto: CreateGroupListingDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.groups.createListing(slug, dto, user.userId);
  }
}

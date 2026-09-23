import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
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
import { CreateSubcommunityDto } from './dto/create-subcommunity.dto';
import { SubcommunitiesService } from './subcommunities.service';

/**
 * A community's spaces. Its own controller so this feature never has to
 * touch `CommunitiesController`; the two-segment paths cannot collide with
 * the `@Get(':slug')` route there.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities')
@UseGuards(ActiveMemberGuard)
export class SubcommunitiesController {
  constructor(private readonly subcommunities: SubcommunitiesService) {}

  @Get(':slug/subcommunities')
  @ApiOperation({
    summary: "List a community's live spaces the caller may see.",
  })
  @ApiOkResponse({
    description:
      '`{ items }` of community cards. `myRole` is the effective role, ' +
      'inherited from parent staff where that is higher. Private spaces ' +
      'appear only to people holding a role in them.',
  })
  @ApiNotFoundResponse({
    description: 'The parent community is not visible to the caller.',
  })
  @ApiForbiddenResponse({
    description: 'The parent community is closed to the caller.',
  })
  list(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.subcommunities
      .list(slug, user.userId)
      .then((items) => ({ items }));
  }

  @Post(':slug/subcommunities')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary:
      'Create a space inside a community (parent owner, co-owner or mod; ' +
      'the caller becomes the space owner).',
  })
  @ApiCreatedResponse({ description: 'The created space detail.' })
  @ApiBadRequestResponse({
    description:
      'The payload is invalid, or `SUBCOMMUNITY_TIER_TOO_OPEN` when the ' +
      'tier is more open than the parent.',
  })
  @ApiForbiddenResponse({
    description: 'The caller is not staff of the parent community.',
  })
  @ApiNotFoundResponse({ description: 'Parent community not found.' })
  @ApiConflictResponse({
    description:
      '`SUBCOMMUNITIES_NOT_ALLOWED` when the parent does not host spaces or ' +
      'is itself a space.',
  })
  create(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateSubcommunityDto,
  ) {
    return this.subcommunities.create(slug, user.userId, dto);
  }
}

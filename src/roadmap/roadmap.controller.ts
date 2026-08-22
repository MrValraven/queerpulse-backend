import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
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
import { Throttle, seconds } from '@nestjs/throttler';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { RoadmapService } from './roadmap.service';
import { CastVoteDto } from './dto/cast-vote.dto';
import { SubmitIdeaDto } from './dto/submit-idea.dto';

/**
 * Member voting and idea submission for `/about/roadmap`. Public reads live
 * separately in `RoadmapPublicController` (`ActiveMemberGuard` does not honor
 * `@Public()`), and the whole admin surface now lives on
 * `AdminRoadmapController` (`/admin/roadmap/*`) behind class-level
 * default-deny rather than per-method `@Roles` on this member-facing class
 * (BE-COM-14).
 */
@Feature('roadmap')
@ApiTags('Roadmap')
@ApiCookieAuth('access_token')
@Controller('roadmap')
@UseGuards(ActiveMemberGuard)
export class RoadmapController {
  constructor(private readonly roadmapService: RoadmapService) {}

  @ApiOperation({
    summary: 'List the roadmap targets the caller has voted for',
  })
  @ApiOkResponse({ description: 'The target ids the caller has voted for.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Get('my-votes')
  myVotes(@CurrentUser() user: CurrentUserData) {
    return this.roadmapService.getMyVotes(user.userId);
  }

  @ApiOperation({ summary: 'Cast a vote for a roadmap item or idea' })
  @ApiCreatedResponse({
    description: 'The target id, its recomputed vote total, and `voted: true`.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @ApiNotFoundResponse({ description: 'No roadmap item or idea with that id.' })
  // Same per-route write throttle every other member-facing write in this
  // codebase carries (forum create/reply/vote, community post/reply/reaction,
  // reports, appeals, nominations). Without it these two fell through to the
  // global limit only (BE-COM-21).
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post('vote')
  vote(@CurrentUser() user: CurrentUserData, @Body() dto: CastVoteDto) {
    return this.roadmapService.castVote(user.userId, dto);
  }

  @ApiOperation({ summary: 'Submit a roadmap idea for moderation' })
  @ApiCreatedResponse({
    description: 'The idea was queued (`{ status: "pending" }`).',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  // Tighter than `vote` above: an idea is a row in the admin queue, and
  // `getAdmin()` loads every idea unpaginated.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('ideas')
  submitIdea(@CurrentUser() user: CurrentUserData, @Body() dto: SubmitIdeaDto) {
    return this.roadmapService.submitIdea(user.userId, dto);
  }
}

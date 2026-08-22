import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { TopicFollowsResponse } from './dto/topic-follows-response';
import { TopicSlugParam } from './dto/topic-slug.param';
import { TopicFollowsService } from './topic-follows.service';

// Topic follows (P2-15). Always-on member primitive (no @Feature flag) —
// mirrors the frontend's `topicFollows.api.ts`:
//   GET    /topics/follows        -> { slugs: string[] }  (seed follow state)
//   POST   /topics/:slug/follow   -> { following: true }  (idempotent)
//   DELETE /topics/:slug/follow   -> { following: false } (idempotent)
//
// NOTE: `:slug` is a topic slug/tag varchar (e.g. "healthcare"), NOT a uuid —
// deliberately NO `ParseUUIDPipe`, which would 400 every valid request. Topics
// have no backend table to resolve the slug against, so it is shape-validated
// instead (`TopicSlugParam`, BE-COM-35): a well-formed but unknown slug still
// follows/unfollows nothing rather than erroring, but arbitrary strings can no
// longer be written as rows.
//
// ROUTE ORDERING: this controller shares the `/topics` path prefix with the
// `content` module's `TopicsController`, whose `@Get(':slug')` would otherwise
// swallow `GET /topics/follows` (matching slug="follows"). `@Get('follows')` is
// declared FIRST here, and `TopicsModule` must be imported BEFORE `ContentModule`
// in `app.module.ts` so this controller's routes register first (Express is
// first-match-wins). See the app.module wiring note in the build report.
@ApiTags('Topics')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Not an active member.' })
@Controller('topics')
@UseGuards(ActiveMemberGuard)
export class TopicFollowsController {
  constructor(private readonly topicFollows: TopicFollowsService) {}

  @ApiOperation({ summary: "List the caller's followed topic slugs." })
  @ApiOkResponse({ description: 'The followed topic slugs.' })
  @Get('follows')
  listFollows(
    @CurrentUser() user: CurrentUserData,
  ): Promise<TopicFollowsResponse> {
    return this.topicFollows.listFollows(user.userId);
  }

  @ApiOperation({ summary: 'Follow a topic (idempotent).' })
  @ApiOkResponse({ description: 'The topic is now followed.' })
  @ApiBadRequestResponse({ description: 'Malformed topic slug.' })
  @ApiConflictResponse({
    description: 'The caller is already following the maximum topic count.',
  })
  @Post(':slug/follow')
  follow(
    @CurrentUser() user: CurrentUserData,
    // Validated shape rather than a bare string — see `TopicSlugParam`
    // (BE-COM-35).
    @Param() params: TopicSlugParam,
  ): Promise<{ following: true }> {
    return this.topicFollows.follow(user.userId, params.slug);
  }

  @ApiOperation({ summary: 'Unfollow a topic (idempotent).' })
  @ApiNoContentResponse({ description: 'The topic is no longer followed.' })
  @ApiBadRequestResponse({ description: 'Malformed topic slug.' })
  @Delete(':slug/follow')
  @HttpCode(HttpStatus.OK)
  unfollow(
    @CurrentUser() user: CurrentUserData,
    @Param() params: TopicSlugParam,
  ): Promise<{ following: false }> {
    return this.topicFollows.unfollow(user.userId, params.slug);
  }
}

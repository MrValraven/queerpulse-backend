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
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Throttle, seconds } from '@nestjs/throttler';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CommunityPostsService } from './community-posts.service';
import { CreateFlatPostDto } from './dto/create-flat-post.dto';
import { FlatReplyDto } from './dto/flat-reply.dto';
import { LikePostDto } from './dto/like-post.dto';
import { UpdateFlatPostDto } from './dto/update-flat-post.dto';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Flat `community-posts` aliases the feed feature calls directly
 * (`features/feed/api/feed.api.ts`), on top of the same post store the
 * nested `CommunitiesController` (`/communities/:slug/posts*`) already
 * serves. Reuses `CommunityPostsService`'s by-id methods — see that file for
 * how `communitySlug` optional and the reserved `like` reaction key work.
 *
 * The update/delete/history routes below are author-only: a flat post/reply
 * has no community, so there's no owner/mod concept to fall back to the way
 * the nested routes do (see `CommunityPostsService`'s `assertAuthorOnly`).
 * Restore is the one exception — it resolves the post's community when it has
 * one, because a tombstone set by a community moderator must not be clearable
 * by the author through this route (see `assertCanRestore`).
 *
 * The write routes carry the same `20 per 60s` per-route throttle the
 * slug-scoped `/communities/:slug/posts*` writes do. Without it these aliases
 * fell through to the global limit only, which made the flat path the cheaper
 * one to spam (BE-COM-02).
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('community-posts')
@UseGuards(ActiveMemberGuard)
export class CommunityPostsController {
  constructor(private readonly communityPostsService: CommunityPostsService) {}

  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post()
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Create a post, optionally scoped to a community by slug.',
  })
  @ApiCreatedResponse({ description: 'The created post id (`{ id }`).' })
  @ApiBadRequestResponse({ description: 'The post payload is invalid.' })
  @ApiForbiddenResponse({
    description:
      'Not a member of the target community, or that community is frozen or archived.',
  })
  @ApiNotFoundResponse({ description: 'The target community was not found.' })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateFlatPostDto) {
    return this.communityPostsService.createFlatPost(user.userId, dto);
  }

  @Patch(':id')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary:
      'Update a post by id (author-only; body/kind/image — no pinning without a community).',
  })
  @ApiOkResponse({ description: 'The updated post.' })
  @ApiBadRequestResponse({
    description: 'Malformed post id or invalid payload.',
  })
  @ApiForbiddenResponse({ description: 'Only the author may edit this post.' })
  @ApiNotFoundResponse({ description: 'No post exists for this id.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFlatPostDto,
  ) {
    return this.communityPostsService.updateFlatPost(id, user.userId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a post by id (author-only).' })
  @ApiOkResponse({ description: 'The post, now tombstoned.' })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiForbiddenResponse({
    description: 'Only the author may delete this post.',
  })
  @ApiNotFoundResponse({ description: 'No post exists for this id.' })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.communityPostsService.deleteFlatPost(id, user.userId);
  }

  @Post(':id/restore')
  @ApiOperation({
    summary:
      'Restore a soft-deleted post by id (whoever deleted it, or a moderator of its community).',
  })
  @ApiCreatedResponse({ description: 'The post, tombstone cleared.' })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiForbiddenResponse({
    description:
      'Only the actor who deleted this post may restore it. A tombstone set ' +
      "by the community's owner/mod needs an owner/mod to lift.",
  })
  @ApiNotFoundResponse({ description: 'No post exists for this id.' })
  restore(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.communityPostsService.restoreFlatPost(id, user.userId);
  }

  @Get(':id/history')
  @ApiOperation({
    summary: "List a post's edit history by id (author-only).",
  })
  @ApiOkResponse({ description: "The post's revisions, newest first." })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiForbiddenResponse({
    description: 'Only the author may view this post history.',
  })
  @ApiNotFoundResponse({ description: 'No post exists for this id.' })
  history(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.communityPostsService.listFlatPostHistory(id, user.userId);
  }

  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post(':id/like')
  @ApiOperation({ summary: 'Like or unlike a post by id (idempotent toggle).' })
  @ApiCreatedResponse({
    description: 'The like state and updated like count.',
  })
  @ApiBadRequestResponse({
    description: 'Malformed post id or invalid payload.',
  })
  @ApiForbiddenResponse({
    description:
      "Not a member of the post's community, or that community is frozen or archived.",
  })
  @ApiNotFoundResponse({ description: 'No post exists for this id.' })
  like(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LikePostDto,
  ) {
    return this.communityPostsService.likeFlatPost(id, user.userId, dto.liked);
  }

  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post(':id/replies')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Reply to a post by id.' })
  @ApiCreatedResponse({ description: 'The created reply id (`{ id }`).' })
  @ApiBadRequestResponse({
    description: 'Malformed post id or invalid payload.',
  })
  @ApiForbiddenResponse({
    description:
      "Not a member of the post's community, or that community is frozen or archived.",
  })
  @ApiNotFoundResponse({ description: 'No post exists for this id.' })
  reply(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FlatReplyDto,
  ) {
    return this.communityPostsService.addFlatReply(id, user.userId, dto.body);
  }

  @Patch(':id/replies/:replyId')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Edit a reply to a post by id (author-only).' })
  @ApiOkResponse({ description: 'The updated reply.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiForbiddenResponse({
    description: 'Only the author may edit this reply.',
  })
  @ApiNotFoundResponse({ description: 'No such post or reply.' })
  updateReply(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('replyId', ParseUUIDPipe) replyId: string,
    @Body() dto: FlatReplyDto,
  ) {
    return this.communityPostsService.updateFlatReply(
      id,
      replyId,
      user.userId,
      dto.body,
    );
  }

  @Delete(':id/replies/:replyId')
  @ApiOperation({
    summary: 'Soft-delete a reply to a post by id (author-only).',
  })
  @ApiOkResponse({ description: 'The reply, now tombstoned.' })
  @ApiBadRequestResponse({ description: 'Malformed id.' })
  @ApiForbiddenResponse({
    description: 'Only the author may delete this reply.',
  })
  @ApiNotFoundResponse({ description: 'No such post or reply.' })
  removeReply(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('replyId', ParseUUIDPipe) replyId: string,
  ) {
    return this.communityPostsService.deleteFlatReply(id, replyId, user.userId);
  }

  @Post(':id/replies/:replyId/restore')
  @ApiOperation({
    summary:
      'Restore a soft-deleted reply by id (whoever deleted it, or a moderator of its community).',
  })
  @ApiCreatedResponse({ description: 'The reply, tombstone cleared.' })
  @ApiBadRequestResponse({ description: 'Malformed id.' })
  @ApiForbiddenResponse({
    description:
      'Only the actor who deleted this reply may restore it. A tombstone set ' +
      "by the community's owner/mod needs an owner/mod to lift.",
  })
  @ApiNotFoundResponse({ description: 'No such post or reply.' })
  restoreReply(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('replyId', ParseUUIDPipe) replyId: string,
  ) {
    return this.communityPostsService.restoreFlatReply(
      id,
      replyId,
      user.userId,
    );
  }

  @Get(':id/replies/:replyId/history')
  @ApiOperation({
    summary: "List a reply's edit history by id (author-only).",
  })
  @ApiOkResponse({ description: "The reply's revisions, newest first." })
  @ApiBadRequestResponse({ description: 'Malformed id.' })
  @ApiForbiddenResponse({
    description: 'Only the author may view this reply history.',
  })
  @ApiNotFoundResponse({ description: 'No such post or reply.' })
  replyHistory(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('replyId', ParseUUIDPipe) replyId: string,
  ) {
    return this.communityPostsService.listFlatReplyHistory(
      id,
      replyId,
      user.userId,
    );
  }
}

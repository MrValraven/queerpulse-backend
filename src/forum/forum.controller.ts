import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CreateThreadDto } from './dto/create-thread.dto';
import { ListPostsQuery } from './dto/list-posts.query';
import { ListThreadsQuery } from './dto/list-threads.query';
import { ReplyThreadDto } from './dto/reply-thread.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { UpdateThreadDto } from './dto/update-thread.dto';
import { VotePostDto } from './dto/vote-post.dto';
import { ForumPostsService } from './forum-posts.service';
import { ForumThreadsService } from './forum-threads.service';
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

@Feature('forum')
@ApiTags('Forum')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Not authenticated as an active member.',
})
@Controller('forum')
@UseGuards(ActiveMemberGuard)
export class ForumController {
  constructor(
    private readonly threadsService: ForumThreadsService,
    private readonly postsService: ForumPostsService,
  ) {}

  @Get('threads')
  @ApiOperation({ summary: 'List forum threads (cursor-paginated)' })
  @ApiOkResponse({ description: 'A page of forum threads.' })
  listThreads(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListThreadsQuery,
  ) {
    return this.threadsService.list(
      user.userId,
      query.category,
      query.cursor,
      query.limit,
    );
  }

  @Get('threads/:slug')
  @ApiOperation({ summary: 'Get a single forum thread by slug' })
  @ApiOkResponse({ description: 'The forum thread.' })
  @ApiNotFoundResponse({ description: 'Thread not found.' })
  getThread(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.threadsService.getBySlug(slug, user.userId);
  }

  @Get('threads/:slug/posts')
  @ApiOperation({ summary: 'List posts in a thread (cursor-paginated)' })
  @ApiOkResponse({ description: 'A page of posts for the thread.' })
  @ApiNotFoundResponse({ description: 'Thread not found.' })
  listPosts(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListPostsQuery,
  ) {
    return this.postsService.listPosts(slug, user, query.cursor, query.limit);
  }

  @Post('threads')
  @ApiOperation({ summary: 'Create a new thread with its opening post' })
  @ApiCreatedResponse({ description: 'The created thread.' })
  @ApiConflictResponse({
    description: 'Could not allocate a unique thread slug.',
  })
  createThread(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateThreadDto,
  ) {
    return this.threadsService.create(user.userId, dto);
  }

  @Post('threads/:slug/posts')
  @ApiOperation({ summary: 'Reply to a thread (optionally nested under a post)' })
  @ApiCreatedResponse({ description: 'The created reply post.' })
  @ApiForbiddenResponse({ description: 'The thread is locked.' })
  @ApiBadRequestResponse({
    description:
      'Parent post is in another thread, or is a deleted post you cannot reply to.',
  })
  @ApiNotFoundResponse({ description: 'Thread or parent post not found.' })
  reply(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: ReplyThreadDto,
  ) {
    return this.postsService.reply(slug, user, dto.body, dto.parentPostId);
  }

  @Post('posts/:id/vote')
  @ApiOperation({ summary: 'Cast or clear an upvote on a post (idempotent)' })
  @ApiCreatedResponse({ description: 'Updated vote count and the caller vote.' })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiNotFoundResponse({ description: 'Post not found.' })
  vote(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VotePostDto,
  ) {
    return this.postsService.vote(id, user.userId, dto.value);
  }

  @Patch('posts/:id')
  @ApiOperation({ summary: 'Edit a post body (author only)' })
  @ApiOkResponse({ description: 'The updated post.' })
  @ApiForbiddenResponse({ description: 'Only the author can edit this post.' })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiNotFoundResponse({ description: 'Post not found or already deleted.' })
  updatePost(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePostDto,
  ) {
    return this.postsService.updatePostBody(id, user, dto.body);
  }

  @Delete('posts/:id')
  @ApiOperation({ summary: 'Soft-delete (tombstone) a post; author or staff' })
  @ApiOkResponse({ description: 'The tombstoned post.' })
  @ApiForbiddenResponse({
    description: 'Only the author or a moderator can delete this post.',
  })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiNotFoundResponse({ description: 'Post not found.' })
  deletePost(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.postsService.tombstonePost(id, user);
  }

  @Post('posts/:id/restore')
  @ApiOperation({ summary: 'Restore a tombstoned post; author or staff' })
  @ApiCreatedResponse({ description: 'The restored post.' })
  @ApiForbiddenResponse({
    description: 'Only the author or a moderator can restore this post.',
  })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiNotFoundResponse({ description: 'Post not found.' })
  restorePost(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.postsService.restorePost(id, user);
  }

  @Get('posts/:id/history')
  @ApiOperation({ summary: 'List a post edit history; author or staff' })
  @ApiOkResponse({ description: 'The revisions, newest first.' })
  @ApiForbiddenResponse({
    description: 'Only the author or a moderator can view this history.',
  })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiNotFoundResponse({ description: 'Post not found.' })
  postHistory(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.postsService.listHistory(id, user);
  }

  @Patch('threads/:slug')
  @ApiOperation({ summary: 'Edit a thread title (author only)' })
  @ApiOkResponse({ description: 'The updated thread.' })
  @ApiForbiddenResponse({ description: 'Only the author can edit this thread.' })
  @ApiNotFoundResponse({ description: 'Thread not found.' })
  updateThread(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateThreadDto,
  ) {
    return this.threadsService.updateThreadTitle(slug, user, dto.title);
  }
}

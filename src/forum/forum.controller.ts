import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { VotePostDto } from './dto/vote-post.dto';
import { ForumPostsService } from './forum-posts.service';
import { ForumThreadsService } from './forum-threads.service';

@Feature('forum')
@Controller('forum')
@UseGuards(ActiveMemberGuard)
export class ForumController {
  constructor(
    private readonly threadsService: ForumThreadsService,
    private readonly postsService: ForumPostsService,
  ) {}

  @Get('threads')
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
  getThread(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.threadsService.getBySlug(slug, user.userId);
  }

  @Get('threads/:slug/posts')
  listPosts(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListPostsQuery,
  ) {
    return this.postsService.listPosts(
      slug,
      user.userId,
      query.cursor,
      query.limit,
    );
  }

  @Post('threads')
  createThread(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateThreadDto,
  ) {
    return this.threadsService.create(user.userId, dto);
  }

  @Post('threads/:slug/posts')
  reply(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: ReplyThreadDto,
  ) {
    return this.postsService.reply(slug, user.userId, dto.body);
  }

  @Post('posts/:id/vote')
  vote(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VotePostDto,
  ) {
    return this.postsService.vote(id, user.userId, dto.value);
  }
}

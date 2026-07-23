import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
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
import { CommunitiesService } from './communities.service';
import { CommunityPostsService } from './community-posts.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { JoinCommunityDto } from './dto/join-community.dto';
import { ListCommunitiesQuery } from './dto/list-communities.query';
import { ReactionDto } from './dto/reaction.dto';
import { ReplyDto } from './dto/reply.dto';
import { TriageJoinRequestDto } from './dto/triage-join-request.dto';
import { UpdateCommunityDto } from './dto/update-community.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { ReactionKey } from './entities/community-post-reaction.entity';

@Feature('communities')
@Controller('communities')
@UseGuards(ActiveMemberGuard)
export class CommunitiesController {
  constructor(
    private readonly communitiesService: CommunitiesService,
    private readonly communityPostsService: CommunityPostsService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListCommunitiesQuery,
  ) {
    return this.communitiesService.list(user.userId, query);
  }

  @Get(':slug')
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communitiesService.getBySlug(slug, user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateCommunityDto,
  ) {
    return this.communitiesService.create(user.userId, dto);
  }

  @Patch(':slug')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateCommunityDto,
  ) {
    return this.communitiesService.update(slug, user.userId, dto);
  }

  @Get(':slug/posts')
  listPosts(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  ) {
    return this.communityPostsService.listPosts(slug, user.userId, page);
  }

  @Post(':slug/posts')
  createPost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreatePostDto,
  ) {
    return this.communityPostsService.createPost(slug, user.userId, dto);
  }

  @Patch(':slug/posts/:id')
  updatePost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePostDto,
  ) {
    return this.communityPostsService.updatePost(slug, id, user.userId, dto);
  }

  @Post(':slug/posts/:id/reactions')
  addReaction(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReactionDto,
  ) {
    return this.communityPostsService.addReaction(
      slug,
      id,
      user.userId,
      dto.key,
    );
  }

  @Delete(':slug/posts/:id/reactions/:key')
  removeReaction(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key', new ParseEnumPipe(ReactionKey)) key: ReactionKey,
  ) {
    return this.communityPostsService.removeReaction(
      slug,
      id,
      user.userId,
      key,
    );
  }

  @Post(':slug/posts/:id/replies')
  addReply(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplyDto,
  ) {
    return this.communityPostsService.addReply(slug, id, user.userId, dto.text);
  }

  @Delete(':slug/posts/:id')
  deletePost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.communityPostsService.deletePost(slug, id, user.userId);
  }

  @Post(':slug/posts/:id/restore')
  restorePost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.communityPostsService.restorePost(slug, id, user.userId);
  }

  @Get(':slug/posts/:id/history')
  postHistory(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.communityPostsService.listPostHistory(slug, id, user.userId);
  }

  @Patch(':slug/posts/:id/replies/:replyId')
  updateReply(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('replyId', ParseUUIDPipe) replyId: string,
    @Body() dto: ReplyDto,
  ) {
    return this.communityPostsService.updateReply(
      slug,
      id,
      replyId,
      user.userId,
      dto.text,
    );
  }

  @Delete(':slug/posts/:id/replies/:replyId')
  deleteReply(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('replyId', ParseUUIDPipe) replyId: string,
  ) {
    return this.communityPostsService.deleteReply(
      slug,
      id,
      replyId,
      user.userId,
    );
  }

  @Post(':slug/posts/:id/replies/:replyId/restore')
  restoreReply(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('replyId', ParseUUIDPipe) replyId: string,
  ) {
    return this.communityPostsService.restoreReply(
      slug,
      id,
      replyId,
      user.userId,
    );
  }

  @Get(':slug/posts/:id/replies/:replyId/history')
  replyHistory(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('replyId', ParseUUIDPipe) replyId: string,
  ) {
    return this.communityPostsService.listReplyHistory(
      slug,
      id,
      replyId,
      user.userId,
    );
  }

  @Get(':slug/roster')
  roster(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communitiesService.roster(slug, user.userId);
  }

  @Post(':slug/join')
  join(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: JoinCommunityDto,
  ) {
    return this.communitiesService.join(slug, user.userId, dto);
  }

  @Get(':slug/join-requests')
  listJoinRequests(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.communitiesService.listJoinRequests(slug, user.userId);
  }

  @Patch(':slug/join-requests/:id')
  triageJoinRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriageJoinRequestDto,
  ) {
    return this.communitiesService.triageJoinRequest(
      slug,
      id,
      user.userId,
      dto.action,
    );
  }

  @Delete(':slug/members/:memberSlug')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeMember(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.communitiesService.removeMember(slug, user.userId, memberSlug);
  }

  /** Promote a member to moderator, or demote a moderator back to member.
   * Owner/mod only, with further restrictions on *which* members each may
   * act on — see `CommunitiesService.setMemberRole` for the full rules. */
  @Patch(':slug/members/:memberSlug')
  setMemberRole(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.communitiesService.setMemberRole(
      slug,
      user.userId,
      memberSlug,
      dto.role,
    );
  }
}

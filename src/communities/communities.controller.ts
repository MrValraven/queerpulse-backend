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
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CommunitiesService } from './communities.service';
import { CommunityPostsService } from './community-posts.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { CreateCommunityTagRequestDto } from './dto/create-community-tag-request.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { JoinCommunityDto } from './dto/join-community.dto';
import { ListCommunitiesQuery } from './dto/list-communities.query';
import { ReactionDto } from './dto/reaction.dto';
import { ReplyDto } from './dto/reply.dto';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import { TriageJoinRequestDto } from './dto/triage-join-request.dto';
import { UpdateCommunityDto } from './dto/update-community.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { ReactionKey } from './entities/community-post-reaction.entity';
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

@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities')
@UseGuards(ActiveMemberGuard)
export class CommunitiesController {
  constructor(
    private readonly communitiesService: CommunitiesService,
    private readonly communityPostsService: CommunityPostsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List communities (discover or mine), paginated and sortable (newest/name).',
  })
  @ApiOkResponse({ description: 'A paginated page of community cards.' })
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListCommunitiesQuery,
  ) {
    return this.communitiesService.list(user.userId, query);
  }

  // Registered before `@Get(':slug')` — Nest/Express matches routes in
  // registration order, so this static path must come first or "featured"
  // would be swallowed as a `:slug` value.
  @Get('featured')
  @ApiOperation({
    summary: 'Get the admin-chosen featured community, or null if none set.',
  })
  @ApiOkResponse({
    description: 'The featured community card, or null.',
  })
  getFeatured(@CurrentUser() user: CurrentUserData) {
    return this.communitiesService.getFeatured(user.userId);
  }

  // Also registered before `@Get(':slug')` — same route-order requirement as
  // `featured` above ("suggested" would otherwise be swallowed as a `:slug`
  // value).
  @Get('suggested')
  @ApiOperation({
    summary:
      "Up to 6 communities the caller's connections have joined that the caller hasn't, ranked by connection overlap.",
  })
  @ApiOkResponse({
    description:
      "Suggested community cards, most-connected-in first. Empty when the caller has no connections, or none of their connections belong to any community the caller hasn't already joined.",
  })
  getSuggested(@CurrentUser() user: CurrentUserData) {
    return this.communitiesService.suggestedCommunities(user.userId);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a community by slug.' })
  @ApiOkResponse({ description: 'The community detail for the viewer.' })
  @ApiNotFoundResponse({
    description:
      'Unknown slug, or a private/removed community the viewer cannot see.',
  })
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communitiesService.getBySlug(slug, user.userId);
  }

  @Get(':slug/related')
  @ApiOperation({
    summary:
      'Up to 4 other communities sharing tags with this one, ranked by overlap.',
  })
  @ApiOkResponse({
    description:
      'Related community cards, highest tag overlap first. Empty when the community has no tags or no overlap exists.',
  })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  related(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communitiesService.relatedCommunities(slug, user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a community (caller becomes owner).' })
  @ApiCreatedResponse({ description: 'The created community detail.' })
  @ApiBadRequestResponse({ description: 'The community payload is invalid.' })
  @ApiConflictResponse({
    description: 'Could not allocate a unique community ref.',
  })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateCommunityDto,
  ) {
    return this.communitiesService.create(user.userId, dto);
  }

  @Patch(':slug')
  @ApiOperation({
    summary:
      'Update a community (owner/mod; access tier and roster visibility are owner-only).',
  })
  @ApiOkResponse({ description: 'The updated community detail.' })
  @ApiBadRequestResponse({
    description:
      'The update payload is invalid. `handle`, `stewards` and `invites` are ' +
      'creation-only and are rejected here rather than silently ignored.',
  })
  @ApiForbiddenResponse({
    description:
      'Owner or moderator role required; changing `accessTier` or ' +
      '`rosterVisible` requires the owner.',
  })
  @ApiConflictResponse({ description: 'The community is archived.' })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateCommunityDto,
  ) {
    return this.communitiesService.update(slug, user.userId, dto);
  }

  @Post(':slug/tag-requests')
  @ApiOperation({
    summary:
      'Suggest a tag for this community (owner/mod only, informational).',
  })
  @ApiCreatedResponse({ description: 'The created tag request.' })
  @ApiBadRequestResponse({ description: 'The request payload is invalid.' })
  @ApiForbiddenResponse({ description: 'Owner or moderator role required.' })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  createTagRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateCommunityTagRequestDto,
  ) {
    return this.communitiesService.createTagRequest(slug, user.userId, dto);
  }

  @Post(':slug/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a community — take it down (owner only, idempotent).',
  })
  @ApiOkResponse({ description: 'The community detail, now archived.' })
  @ApiForbiddenResponse({ description: 'Only the owner may archive.' })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  archive(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communitiesService.archive(slug, user.userId);
  }

  @Post(':slug/freeze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Manually freeze a community ahead of moderation review (owner/mod, idempotent).',
  })
  @ApiOkResponse({ description: 'The community detail, now frozen.' })
  @ApiForbiddenResponse({ description: 'Only an owner or mod may freeze.' })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  freeze(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communitiesService.freeze(slug, user.userId);
  }

  @Post(':slug/unfreeze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Lift a freeze (automatic or manual) once reports are handled (owner/mod, idempotent).',
  })
  @ApiOkResponse({ description: 'The community detail, no longer frozen.' })
  @ApiForbiddenResponse({ description: 'Only an owner or mod may unfreeze.' })
  @ApiConflictResponse({
    description:
      'The freeze was applied by moderation (an emergency report or a report ' +
      'pile-up) and the community still has open reports. Resolve them first, ' +
      'or ask platform staff to lift it.',
  })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  unfreeze(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communitiesService.unfreeze(slug, user.userId);
  }

  @Post(':slug/transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transfer ownership to another member (owner only).',
  })
  @ApiOkResponse({ description: 'The community detail under the new owner.' })
  @ApiBadRequestResponse({
    description:
      'Self-transfer, or a transfer to the house account, is not allowed.',
  })
  @ApiForbiddenResponse({ description: 'Only the owner may transfer.' })
  @ApiNotFoundResponse({ description: 'No such community or member.' })
  transfer(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: TransferOwnershipDto,
  ) {
    return this.communitiesService.transferOwnership(
      slug,
      user.userId,
      dto.memberSlug,
    );
  }

  @Get(':slug/posts')
  @ApiOperation({ summary: "List a community's posts, paginated." })
  @ApiOkResponse({ description: 'A paginated page of community posts.' })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or a private community the viewer is not in.',
  })
  listPosts(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  ) {
    return this.communityPostsService.listPosts(slug, user.userId, page);
  }

  @Post(':slug/posts')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Create a post in a community (members only).' })
  @ApiCreatedResponse({ description: 'The created community post.' })
  @ApiBadRequestResponse({ description: 'The post payload is invalid.' })
  @ApiForbiddenResponse({ description: 'Community membership required.' })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  createPost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreatePostDto,
  ) {
    return this.communityPostsService.createPost(slug, user.userId, dto);
  }

  @Patch(':slug/posts/:id')
  @ApiOperation({
    summary: 'Update a post (author edits body/kind; owner/mod pins).',
  })
  @ApiOkResponse({ description: 'The updated community post.' })
  @ApiBadRequestResponse({
    description: 'Malformed post id or invalid payload.',
  })
  @ApiForbiddenResponse({
    description: 'Only the author may edit; only a moderator may pin.',
  })
  @ApiNotFoundResponse({ description: 'No such community or post.' })
  updatePost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePostDto,
  ) {
    return this.communityPostsService.updatePost(slug, id, user.userId, dto);
  }

  @Post(':slug/posts/:id/reactions')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Add a reaction to a post (idempotent).' })
  @ApiCreatedResponse({ description: 'The post with updated reactions.' })
  @ApiBadRequestResponse({
    description: 'Malformed post id or invalid payload.',
  })
  @ApiForbiddenResponse({ description: 'Community membership required.' })
  @ApiNotFoundResponse({ description: 'No such community or post.' })
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
  @ApiOperation({ summary: 'Remove a reaction from a post.' })
  @ApiOkResponse({ description: 'The post with updated reactions.' })
  @ApiBadRequestResponse({
    description: 'Malformed post id or unknown reaction key.',
  })
  @ApiForbiddenResponse({ description: 'Community membership required.' })
  @ApiNotFoundResponse({ description: 'No such community or post.' })
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
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Reply to a community post.' })
  @ApiCreatedResponse({ description: 'The created reply.' })
  @ApiBadRequestResponse({
    description: 'Malformed post id or invalid payload.',
  })
  @ApiForbiddenResponse({ description: 'Community membership required.' })
  @ApiNotFoundResponse({ description: 'No such community or post.' })
  addReply(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplyDto,
  ) {
    return this.communityPostsService.addReply(slug, id, user.userId, dto.text);
  }

  @Get(':slug/posts/:id/replies')
  @ApiOperation({
    summary:
      "List a post's replies beyond its bounded preview, paginated (oldest-first).",
  })
  @ApiOkResponse({ description: "A paginated page of the post's replies." })
  @ApiNotFoundResponse({ description: 'No such community or post.' })
  listReplies(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  ) {
    return this.communityPostsService.listReplies(slug, id, user.userId, page);
  }

  @Delete(':slug/posts/:id')
  @ApiOperation({ summary: 'Soft-delete a post (author or owner/mod).' })
  @ApiOkResponse({ description: 'The post, now tombstoned.' })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiForbiddenResponse({
    description: 'Author or owner/moderator role required.',
  })
  @ApiNotFoundResponse({ description: 'No such community or post.' })
  deletePost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.communityPostsService.deletePost(slug, id, user.userId);
  }

  @Post(':slug/posts/:id/restore')
  @ApiOperation({
    summary:
      'Restore a soft-deleted post (whoever deleted it, or an owner/mod).',
  })
  @ApiCreatedResponse({ description: 'The post, tombstone cleared.' })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiForbiddenResponse({
    description:
      'Author or owner/moderator role required, AND only the actor who set ' +
      'the tombstone may clear it — an owner/mod takedown needs an owner/mod ' +
      'to lift.',
  })
  @ApiNotFoundResponse({ description: 'No such community or post.' })
  restorePost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.communityPostsService.restorePost(slug, id, user.userId);
  }

  @Get(':slug/posts/:id/history')
  @ApiOperation({
    summary: "List a post's edit history (author or owner/mod).",
  })
  @ApiOkResponse({ description: "The post's revisions, newest first." })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiForbiddenResponse({
    description: 'Author or owner/moderator role required.',
  })
  @ApiNotFoundResponse({ description: 'No such community or post.' })
  postHistory(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.communityPostsService.listPostHistory(slug, id, user.userId);
  }

  @Get(':slug/reports')
  @ApiOperation({
    summary: 'List open reports scoped to this community (owner/mod only).',
  })
  @ApiOkResponse({
    description:
      'Open reports whose subject is a post or reply in this community.',
  })
  @ApiForbiddenResponse({ description: 'Owner/moderator role required.' })
  @ApiNotFoundResponse({ description: 'No such community.' })
  listReports(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.communityPostsService.listCommunityReports(slug, user.userId);
  }

  @Patch(':slug/posts/:id/replies/:replyId')
  @ApiOperation({ summary: 'Edit a reply (author only).' })
  @ApiOkResponse({ description: 'The updated reply.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiForbiddenResponse({ description: 'Only the author may edit this reply.' })
  @ApiNotFoundResponse({ description: 'No such community, post, or reply.' })
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
  @ApiOperation({ summary: 'Soft-delete a reply (author or owner/mod).' })
  @ApiOkResponse({ description: 'The reply, now tombstoned.' })
  @ApiBadRequestResponse({ description: 'Malformed id.' })
  @ApiForbiddenResponse({
    description: 'Author or owner/moderator role required.',
  })
  @ApiNotFoundResponse({ description: 'No such community, post, or reply.' })
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
  @ApiOperation({
    summary:
      'Restore a soft-deleted reply (whoever deleted it, or an owner/mod).',
  })
  @ApiCreatedResponse({ description: 'The reply, tombstone cleared.' })
  @ApiBadRequestResponse({ description: 'Malformed id.' })
  @ApiForbiddenResponse({
    description:
      'Author or owner/moderator role required, AND only the actor who set ' +
      'the tombstone may clear it — an owner/mod takedown needs an owner/mod ' +
      'to lift.',
  })
  @ApiNotFoundResponse({ description: 'No such community, post, or reply.' })
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
  @ApiOperation({
    summary: "List a reply's edit history (author or owner/mod).",
  })
  @ApiOkResponse({ description: "The reply's revisions, newest first." })
  @ApiBadRequestResponse({ description: 'Malformed id.' })
  @ApiForbiddenResponse({
    description: 'Author or owner/moderator role required.',
  })
  @ApiNotFoundResponse({ description: 'No such community, post, or reply.' })
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
  @ApiOperation({ summary: "List a community's roster, paginated." })
  @ApiOkResponse({
    description: "A paginated page of the community's roster entries.",
  })
  @ApiForbiddenResponse({
    description: 'The roster is members-only and the caller is not a member.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or a private community the caller is not in.',
  })
  roster(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  ) {
    return this.communitiesService.roster(slug, user.userId, page);
  }

  @Post(':slug/join')
  @ApiOperation({
    summary: 'Join a community, or request to join (idempotent).',
  })
  @ApiCreatedResponse({
    description: 'The join outcome: joined immediately, or a pending request.',
  })
  @ApiBadRequestResponse({ description: 'The join payload is invalid.' })
  @ApiConflictResponse({ description: 'A join request is already pending.' })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  join(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: JoinCommunityDto,
  ) {
    return this.communitiesService.join(slug, user.userId, dto);
  }

  @Get(':slug/join-requests')
  @ApiOperation({
    summary: 'List pending join requests for a community (owner/mod only).',
  })
  @ApiOkResponse({ description: 'The pending join requests.' })
  @ApiForbiddenResponse({ description: 'Owner or moderator role required.' })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  listJoinRequests(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.communitiesService.listJoinRequests(slug, user.userId);
  }

  @Patch(':slug/join-requests/:id')
  @ApiOperation({
    summary: 'Approve or decline a join request (owner/mod only).',
  })
  @ApiOkResponse({ description: 'The join request with its resolved status.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid action.' })
  @ApiForbiddenResponse({ description: 'Owner or moderator role required.' })
  @ApiConflictResponse({ description: 'The join request is already resolved.' })
  @ApiNotFoundResponse({ description: 'No such community or join request.' })
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
  @ApiOperation({
    summary: 'Remove a member, or leave the community yourself.',
  })
  @ApiNoContentResponse({ description: 'The member was removed.' })
  @ApiBadRequestResponse({ description: 'The owner cannot be removed.' })
  @ApiForbiddenResponse({
    description:
      'Removing another member requires owner/moderator role, and removing ' +
      'another MODERATOR requires the owner (mirrors the role-change rule).',
  })
  @ApiNotFoundResponse({ description: 'No such community or member.' })
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
  @ApiOperation({
    summary: 'Promote a member to moderator, or demote a moderator to member.',
  })
  @ApiOkResponse({ description: "The member's new role." })
  @ApiBadRequestResponse({
    description: "Invalid role, or the owner's role cannot be changed.",
  })
  @ApiForbiddenResponse({
    description:
      'Owner/mod required; cannot change your own role; only the owner may change a moderator.',
  })
  @ApiNotFoundResponse({ description: 'No such community or member.' })
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

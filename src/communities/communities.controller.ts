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
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CommunitiesService } from './communities.service';
import { CommunityPostsService } from './community-posts.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { CreateCommunityTagRequestDto } from './dto/create-community-tag-request.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { FreezeCommunityDto } from './dto/freeze-community.dto';
import { JoinCommunityDto } from './dto/join-community.dto';
import { ListCommunitiesQuery } from './dto/list-communities.query';
import { ListJoinRequestsQuery } from './dto/list-join-requests.query';
import { ReactionDto } from './dto/reaction.dto';
import { RemoveMemberQuery } from './dto/remove-member.query';
import { ReplyDto } from './dto/reply.dto';
import { ListCommunityPostsQuery } from './dto/list-community-posts.query';
import { RosterQuery } from './dto/roster.query';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import { TriageCommunityJoinRequestDto } from './dto/triage-join-request.dto';
import { UpdateCommunityDto } from './dto/update-community.dto';
import { UpdateCommunityMemberRoleDto } from './dto/update-member-role.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { ReactionKey } from './entities/community-post-reaction.entity';
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
  ApiUnprocessableEntityResponse,
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
      'List communities (discover or mine), paginated, filterable by type, ' +
      'access tier, tags, city, language, online and busy, and sortable by ' +
      'newest/name/active.',
    description:
      '`sort=active` orders by `communities.active_this_week`, the indexed, ' +
      'hourly-refreshed count of distinct members who posted or replied in ' +
      'the trailing week, and `busy=true` narrows to the ones at or above ' +
      'the busy threshold off the same counter. Each card carries that ' +
      'number too, so a "busy this week" treatment needs no second call.',
  })
  @ApiOkResponse({
    description:
      'A paginated page of community cards, plus `facets` — how many ' +
      'communities each curated tag (`facets.tags`), the open-to-all filter ' +
      '(`facets.openToAll`) and the busy filter (`facets.busy`) would yield ' +
      "under the rest of this request's filters, each with its own predicate " +
      'lifted, so the browse can number its chips and toggles and grey out ' +
      'the ones that lead nowhere.',
  })
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
  @UseGuards(NotRestrictedGuard)
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
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary:
      'Update a community (owner/mod; access tier and roster visibility are owner-only).',
  })
  @ApiOkResponse({ description: 'The updated community detail.' })
  @ApiBadRequestResponse({
    description:
      'The update payload is invalid. `handle`, `stewards` and `invites` are ' +
      'creation-only and are rejected here rather than silently ignored. ' +
      '`isPubliclyListed: true` is refused unless the resulting access tier ' +
      'is `public` or `request`; moving the tier to `invite`/`private` ' +
      'forces the community back to unlisted in the same update.',
  })
  @ApiForbiddenResponse({
    description:
      'Owner or moderator role required; changing `accessTier`, ' +
      '`rosterVisible` or `isPubliclyListed` requires an owner or co-owner.',
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
  @UseGuards(NotRestrictedGuard)
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
    description:
      'The optional `note` is a short PUBLIC line members read alongside the ' +
      'frozen state ("paused while we rewrite the rules"). The body may be ' +
      'omitted entirely. Who applied the freeze is recorded on the community ' +
      'and is not part of any response.',
  })
  @ApiOkResponse({ description: 'The community detail, now frozen.' })
  @ApiBadRequestResponse({ description: 'The freeze payload is invalid.' })
  @ApiForbiddenResponse({ description: 'Only an owner or mod may freeze.' })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  freeze(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: FreezeCommunityDto,
  ) {
    return this.communitiesService.freeze(slug, user.userId, dto);
  }

  @Post(':slug/unfreeze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Lift a freeze (automatic or manual) once reports are handled (owner/mod, idempotent).',
  })
  @ApiOkResponse({
    description:
      'The community detail, no longer frozen. The freeze note and the actor ' +
      'that applied it are cleared with the freeze.',
  })
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
  @ApiOperation({
    summary: "List a community's posts, paginated and searchable via `q`.",
  })
  @ApiOkResponse({ description: 'A paginated page of community posts.' })
  @ApiBadRequestResponse({ description: 'Invalid `page` or `q`.' })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or a private community the viewer is not in.',
  })
  listPosts(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListCommunityPostsQuery,
  ) {
    return this.communityPostsService.listPosts(
      slug,
      user.userId,
      query.page,
      query.q,
    );
  }

  @Get(':slug/posts/:id')
  @ApiOperation({
    summary: 'Read one community post by id, for its permalink page.',
  })
  @ApiOkResponse({ description: 'The community post.' })
  @ApiBadRequestResponse({ description: 'Malformed post id.' })
  @ApiNotFoundResponse({
    description:
      'Unknown slug or post, a private community the viewer is not in, or a ' +
      'post withheld from this viewer (blocked/muted author, or a ' +
      'moderator-hidden post and the viewer is not staff).',
  })
  getPost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.communityPostsService.getPost(slug, id, user.userId);
  }

  @Post(':slug/posts')
  @UseGuards(NotRestrictedGuard)
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
  @UseGuards(NotRestrictedGuard)
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
  @UseGuards(NotRestrictedGuard)
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
      'Open reports whose subject is a post or reply in this community, each ' +
      'carrying the reported content: excerpt, author, thread id, severity, ' +
      'SLA state and current moderation state.',
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
  @UseGuards(NotRestrictedGuard)
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
  @ApiOperation({
    summary:
      "List a community's roster, paginated, with an optional `q` search over member name and handle.",
  })
  @ApiOkResponse({
    description:
      "A paginated page of the community's roster entries. `q` filters " +
      'server-side across the whole roster (case-insensitive, matching first ' +
      'name, last name, full name or handle), so `total` counts matches.',
  })
  @ApiBadRequestResponse({ description: 'Invalid `page` or `q`.' })
  @ApiForbiddenResponse({
    description: 'The roster is members-only and the caller is not a member.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or a private community the caller is not in.',
  })
  roster(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: RosterQuery,
  ) {
    return this.communitiesService.roster(
      slug,
      user.userId,
      query.page,
      query.q,
    );
  }

  @Post(':slug/join')
  @ApiOperation({
    summary: 'Join a community, or request to join (idempotent).',
  })
  @ApiCreatedResponse({
    description: 'The join outcome: joined immediately, or a pending request.',
  })
  @ApiBadRequestResponse({
    description:
      'The join payload is invalid. A community with house rules also ' +
      'answers 400 with `code: "RULES_ACCEPTANCE_REQUIRED"` and the ' +
      '`rulesVersion` to agree to, when `acceptedRulesVersion` is missing or ' +
      'out of date.',
  })
  @ApiForbiddenResponse({
    description:
      'The community is frozen, the caller is barred from it ' +
      '(`code: "BANNED_FROM_COMMUNITY"`), or a previous decline set a reapply ' +
      'date that has not passed (`code: "REAPPLY_TOO_SOON"`, with ' +
      '`reapplyAfter`).',
  })
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
    summary:
      'List pending join requests for a community, with reviewer context (owner/mod only).',
  })
  @ApiOkResponse({
    description:
      'A `{ items, total, page, pageSize }` page of the pending join requests, ' +
      'oldest first (ENG-41: this used to be a flat array silently capped at ' +
      '200, which hid the newest arrivals). `total` is the size of the whole ' +
      'pending queue, so a moderator can see there is more to reach and page ' +
      'to it. Each item carries the applicant (slug and pronouns ride on ' +
      '`member`), their stated `involvement`, when their ACCOUNT was created, ' +
      'how many connections they share with the reviewing moderator, and how ' +
      "many communities they share with this community's roster. All of it " +
      'computed in batch for the whole page.',
  })
  @ApiForbiddenResponse({ description: 'Owner or moderator role required.' })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  listJoinRequests(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListJoinRequestsQuery,
  ) {
    return this.communitiesService.listJoinRequests(slug, user.userId, query);
  }

  @Patch(':slug/join-requests/:id')
  @ApiOperation({
    summary:
      'Approve or decline a join request, with the kind of decline and an optional reason (owner/mod only).',
  })
  @ApiOkResponse({
    description:
      'The join request with its resolved status. A decline also carries ' +
      '`declineKind`, `declineReason` and the `reapplyAfter` date it set ' +
      '(30 days for `not_now`, 180 for `not_a_fit`).',
  })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiForbiddenResponse({ description: 'Owner or moderator role required.' })
  @ApiConflictResponse({ description: 'The join request is already resolved.' })
  @ApiUnprocessableEntityResponse({
    description:
      'This community requires a vouch from a current member before the ' +
      'applicant can be admitted (approve only).',
  })
  @ApiNotFoundResponse({ description: 'No such community or join request.' })
  triageJoinRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriageCommunityJoinRequestDto,
  ) {
    return this.communitiesService.triageJoinRequest(slug, id, user.userId, {
      action: dto.action,
      declineKind: dto.declineKind,
      declineReason: dto.declineReason,
    });
  }

  // PRD-25: answers 200 with a `CommunityRemovalOutcomeDTO` rather than the
  // bare 204 it used to. Asking for a permanent bar can now land in three
  // different places (waiting on a second signature, standing as 30 days
  // because this community has nobody else who could sign, or unchanged
  // because a `banDays` term was given), and a caller told nothing would
  // believe they got the one they asked for. The body carries the outcome
  // plus one server-owned sentence to show.
  @Delete(':slug/members/:memberSlug')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Remove a member (barring their return unless `allowReturn=true`), or leave the community yourself.',
  })
  @ApiOkResponse({
    description:
      'The member was removed. Unless `allowReturn=true`, the removal also ' +
      'bars them from re-joining at any access tier. A member removing ' +
      'THEMSELVES is never barred, whatever the query says. `banDays` makes ' +
      'that bar temporary; ABSENT means permanent, which applies a 30-day bar ' +
      'at once and opens a hold for a second owner, co-owner or moderator to ' +
      'sign within 72 hours (a community with no second eligible signatory ' +
      'keeps the 30-day bar and opens no hold). `ruleIndex` cites one ' +
      "of the community's own house rules as the grounds.",
  })
  @ApiBadRequestResponse({
    description: 'The owner cannot be removed, or the query is invalid.',
  })
  @ApiForbiddenResponse({
    description:
      'Removing another member requires owner/moderator role, removing ' +
      'another MODERATOR requires an owner or co-owner (mirrors the ' +
      'role-change rule), and removing a CO-OWNER requires the owner.',
  })
  @ApiNotFoundResponse({ description: 'No such community or member.' })
  removeMember(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
    @Query() query: RemoveMemberQuery,
  ) {
    return this.communitiesService.removeMember(slug, user.userId, memberSlug, {
      allowReturn: query.allowReturn,
      reason: query.reason,
      banDays: query.banDays,
      ruleIndex: query.ruleIndex,
    });
  }

  /** Promote a member to moderator or co-owner, or demote them back.
   * Owner/mod only, with further restrictions on *which* members each may
   * act on — see `CommunitiesService.setMemberRole` for the full rules. */
  @Patch(':slug/members/:memberSlug')
  @ApiOperation({
    summary:
      'Change a member\'s roster role (member, mod, or co-owner; "co-owner" is owner-granted only).',
  })
  @ApiOkResponse({ description: "The member's new role." })
  @ApiBadRequestResponse({
    description: "Invalid role, or the owner's role cannot be changed.",
  })
  @ApiForbiddenResponse({
    description:
      'Owner/mod required; cannot change your own role; changing a ' +
      "moderator's role requires an owner or co-owner; granting co-owner, or " +
      "changing a co-owner's role, requires the owner.",
  })
  @ApiNotFoundResponse({ description: 'No such community or member.' })
  setMemberRole(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
    @Body() dto: UpdateCommunityMemberRoleDto,
  ) {
    return this.communitiesService.setMemberRole(
      slug,
      user.userId,
      memberSlug,
      dto.role,
    );
  }
}

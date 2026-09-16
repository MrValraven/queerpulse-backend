import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  PipeTransform,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import {
  assertNotRestricted,
  NotRestrictedGuard,
} from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { ConversationMediaService } from './conversation-media.service';
import { ConversationsService } from './conversations.service';
import { AddMembersDto } from './dto/add-members.dto';
import { ChangeMemberRoleDto } from './dto/change-member-role.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CreateGroupConversationDto } from './dto/create-group.dto';
import { DeleteMessageDto } from './dto/delete-message.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { GetMessagesQuery } from './dto/get-messages.query';
import { ListConversationMediaQuery } from './dto/list-conversation-media.query';
import { ListConversationsQuery } from './dto/list-conversations.query';
import { MarkReadDto } from './dto/mark-read.dto';
import { MessageReactionDto } from './dto/message-reaction.dto';
import { MessageRequestDto } from './dto/message-request.dto';
import { SearchMessagesQuery } from './dto/search-messages.query';
import { SendMessageDto } from './dto/send-message.dto';
import { StarredMessagesQuery } from './dto/starred-messages.query';
import { TransferGroupOwnershipDto } from './dto/transfer-group-ownership.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { MessageReactionKey } from './entities/message-reaction.entity';
import {
  ConversationListPage,
  ConversationResponse,
  GroupInviteSummary,
  GroupJoinPreview,
  MessageHistoryPage,
  MessageReactorsResponse,
  MessageResponse,
} from './message-response';
import { MessagingService } from './messaging.service';
import { Throttle, seconds } from '@nestjs/throttler';
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
 * `join/:token` param guard (messaging scan section 8, item 12):
 * `conversations.invite_token` is `varchar(64)`, and a bare `@Param('token')`
 * accepts a string of any length before that lookup query runs. Kept local
 * to this controller: no other route in the app takes a raw invite-link
 * token as a path param.
 */
@Injectable()
class InviteTokenParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!value || value.length > 64) {
      throw new BadRequestException('Invalid invite link');
    }
    return value;
  }
}

@Feature('messaging')
@ApiTags('Messaging')
@ApiCookieAuth()
@ApiUnauthorizedResponse({
  description: 'Not authenticated as an active member.',
})
@Controller('conversations')
@UseGuards(ActiveMemberGuard)
export class ConversationsController {
  constructor(
    private readonly messagingService: MessagingService,
    private readonly conversationMediaService: ConversationMediaService,
    // ENG-253: called directly (not through the `MessagingService` facade)
    // ONLY for the two routes below, whose shape the facade's own
    // backward-compatible `listConversations` overload cannot express.
    // See that method's own doc.
    private readonly conversationsService: ConversationsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "List the caller's conversations (inbox), newest activity first",
  })
  @ApiOkResponse({
    description:
      "ENG-253: one cursor-paginated page of the caller's conversations " +
      "(`ConversationListPage`), trimmed for a list row: a group's " +
      '`members` roster and `draft` body are empty/absent here; read ' +
      '`GET /conversations/:id` for those.',
  })
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListConversationsQuery,
  ): Promise<ConversationListPage> {
    return this.conversationsService.listConversations(user.userId, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /**
   * GET /conversations/unread-count — the single number for the nav DM badge,
   * so the badge never pulls the whole inbox app-wide on every route. Mirrors
   * GET /notifications/unread-count. A static segment declared before the
   * `:id/*` routes below, so it can never be captured as an `:id`.
   */
  @Get('unread-count')
  @ApiOperation({
    summary: 'Count the conversations that have at least one unread message',
  })
  @ApiOkResponse({
    description: 'The number of unread conversations, for the nav DM badge.',
  })
  async unreadCount(
    @CurrentUser() user: CurrentUserData,
  ): Promise<{ count: number }> {
    const count = await this.messagingService.unreadConversationCount(
      user.userId,
    );
    return { count };
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Post()
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Open (or reuse) a 1:1 conversation with a member by handle',
  })
  @ApiCreatedResponse({
    description: 'The conversation (existing or newly created).',
  })
  @ApiBadRequestResponse({
    description: 'Invalid body, or the recipient is the caller.',
  })
  @ApiForbiddenResponse({
    description:
      'One has blocked the other; the caller is under an active moderation restriction; or the two are not accepted connections and no thread between them is already open (PRD-340). A fresh thread with a non-connection must go through a message request or enquiry instead.',
  })
  @ApiNotFoundResponse({ description: 'The recipient handle does not exist.' })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateConversationDto,
  ) {
    return this.messagingService.createConversation(
      user.userId,
      dto.recipientHandle,
    );
  }

  /**
   * Create a GROUP conversation (feature #17). The caller becomes owner; each
   * `memberHandles` slug joins as a member (gated: connected + not blocked). A
   * static path segment ('group'), so it can never collide with the `:id`
   * routes below.
   */
  @Throttle({ default: { limit: 15, ttl: seconds(60) } })
  @Post('group')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Create a group conversation (caller becomes owner)',
  })
  @ApiCreatedResponse({ description: 'The newly created group conversation.' })
  @ApiBadRequestResponse({
    description: 'Missing title, or no valid other members supplied.',
  })
  @ApiNotFoundResponse({
    description: 'One of the member handles does not exist.',
  })
  createGroup(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateGroupConversationDto,
  ) {
    return this.messagingService.createGroup(
      user.userId,
      dto.title,
      dto.memberHandles,
      dto.avatarUrl,
    );
  }

  /**
   * PRD-353: literal-prefix routes declared BEFORE any `:id`-first route of
   * the same segment count below (`:id/leave`, `:id/members`, …), so
   * `group-invites`/`join` can never be swallowed as a `:id` value.
   */

  /** `GET /conversations/group-invites`: every PENDING invite addressed to
   *  the caller. Bare array (the frontend contract), never a wrapper. */
  @Get('group-invites')
  @ApiOperation({ summary: "List the caller's pending group invites" })
  @ApiOkResponse({
    description: 'The pending invites addressed to the caller.',
  })
  listGroupInvites(
    @CurrentUser() user: CurrentUserData,
  ): Promise<GroupInviteSummary[]> {
    return this.messagingService.listGroupInvites(user.userId);
  }

  /**
   * `GET /conversations/:id` (ENG-253): the single-conversation read path a
   * client fetches when it OPENS a thread. Returns the full group roster with
   * per-member read/delivered watermarks and the caller's own untruncated
   * draft, neither of which the inbox list row (`GET /conversations`) sends
   * anymore (see `ConversationResponse.members`/`.draft`'s own docs).
   * Declared AFTER every other one-segment `GET` on this controller
   * (`unread-count`, `group-invites`) so neither literal path is ever
   * swallowed as an `:id` value. Nest/Express matches routes in
   * registration order, and a same-segment-count literal only wins over a
   * dynamic segment if it is registered first.
   */
  @Get(':id')
  @ApiOperation({
    summary:
      'Read one conversation in full detail (open-thread roster + draft)',
  })
  @ApiOkResponse({
    description:
      "The conversation's full detail: the group's member roster with " +
      "read/delivered watermarks, and the caller's own untruncated draft.",
  })
  @ApiNotFoundResponse({
    description:
      'Not a participant, or the thread is cleared/blocked and not currently visible to the caller.',
  })
  getOne(
    @Param('id', ParseUUIDPipe) conversationId: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<ConversationResponse> {
    return this.conversationsService.getConversation(
      conversationId,
      user.userId,
    );
  }

  /**
   * Accept a group invite (invitee only). Re-checks the invite is still
   * pending, the group has not been dissolved, the cap, and the block gate,
   * then seats the caller and posts a `member_joined` pill.
   */
  @Throttle({ default: { limit: 15, ttl: seconds(60) } })
  @Post('group-invites/:inviteId/accept')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Accept a pending group invite' })
  @ApiOkResponse({ description: 'The now-joined group conversation.' })
  @ApiForbiddenResponse({
    description: 'The group has ended, or the caller is blocked either way.',
  })
  @ApiNotFoundResponse({ description: 'That invite no longer exists.' })
  acceptGroupInvite(
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<ConversationResponse> {
    return this.messagingService.acceptGroupInvite(inviteId, user.userId);
  }

  /** Decline a group invite (invitee only). */
  @Throttle({ default: { limit: 15, ttl: seconds(60) } })
  @Post('group-invites/:inviteId/decline')
  @HttpCode(204)
  @ApiOperation({ summary: 'Decline a pending group invite' })
  @ApiOkResponse({ description: 'The invite is declined.' })
  @ApiNotFoundResponse({ description: 'That invite no longer exists.' })
  async declineGroupInvite(
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<void> {
    await this.messagingService.declineGroupInvite(inviteId, user.userId);
  }

  /**
   * `GET /conversations/join/:token`: an unauthenticated-membership preview
   * before deciding whether to `POST` the same path. Throttled like other
   * token lookups.
   */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Get('join/:token')
  @ApiOperation({ summary: 'Preview a group before joining it by link' })
  @ApiOkResponse({ description: 'The group preview.' })
  @ApiNotFoundResponse({
    description: 'The link is unknown, or the group has ended.',
  })
  previewGroupJoin(
    @Param('token', InviteTokenParamPipe) token: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<GroupJoinPreview> {
    return this.messagingService.previewGroupJoin(token, user.userId);
  }

  /**
   * `POST /conversations/join/:token`: the caller joins voluntarily (their
   * own `group_add_policy` is never consulted). Idempotent for an
   * already-active member; refused for a member an owner/admin removed.
   */
  @Throttle({ default: { limit: 15, ttl: seconds(60) } })
  @Post('join/:token')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Join a group by its invite link' })
  @ApiOkResponse({ description: 'The now-joined group conversation.' })
  @ApiForbiddenResponse({
    description:
      'The caller was removed from this group, or is blocked either way.',
  })
  @ApiNotFoundResponse({
    description: 'The link is unknown, or the group has ended.',
  })
  joinGroupByToken(
    @Param('token', InviteTokenParamPipe) token: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<ConversationResponse> {
    return this.messagingService.joinGroupByToken(token, user.userId);
  }

  /** The caller leaves a group (sets their `left_at`, posts a `member_left`
   *  system message; an owner who leaves hands ownership to a successor). */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Post(':id/leave')
  @ApiOperation({ summary: 'Leave a group conversation' })
  @ApiOkResponse({ description: 'The caller has left the group.' })
  @ApiBadRequestResponse({ description: 'Not a group conversation.' })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  leave(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.leaveGroup(id, user.userId);
  }

  /**
   * Add members to a group by handle (owner/admin only — the SERVICE re-checks
   * the caller's role). Each member is gated like a DM start (connected + not
   * blocked); an already-active member is skipped. Emits a `member_added` pill
   * per add and fans the group to each new member's socket room.
   */
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post(':id/members')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Add members to a group by handle (owner/admin only)',
  })
  @ApiOkResponse({ description: 'The updated group conversation.' })
  @ApiBadRequestResponse({
    description: 'Not a group, or no valid new members supplied.',
  })
  @ApiForbiddenResponse({
    description: 'The caller is not a group owner/admin.',
  })
  @ApiNotFoundResponse({
    description: 'One of the member handles does not exist.',
  })
  addMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: AddMembersDto,
  ) {
    return this.messagingService.addMembers(id, user.userId, dto.memberHandles);
  }

  /**
   * Remove a member from a group (owner/admin only — service re-checks the
   * role). The owner can't be removed, and only the owner may remove an admin.
   */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Delete(':id/members/:userId')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Remove a member from a group (owner/admin only)' })
  @ApiOkResponse({ description: 'The updated group conversation.' })
  @ApiBadRequestResponse({
    description: 'Use the leave endpoint to remove yourself.',
  })
  @ApiForbiddenResponse({
    description:
      'The caller lacks the role, or is trying to remove the owner/an admin without permission.',
  })
  @ApiNotFoundResponse({ description: 'That member is not in this group.' })
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.removeMember(id, user.userId, userId);
  }

  /**
   * Promote/demote a member (OWNER only — service re-checks). Body `{ role }` is
   * `admin` or `member`; the `owner` role is never assignable here.
   */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Patch(':id/members/:userId/role')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary:
      'Promote/demote a group member between admin and member (owner only)',
  })
  @ApiOkResponse({ description: 'The updated group conversation.' })
  @ApiBadRequestResponse({
    description: 'Invalid role, or attempting to change your own role.',
  })
  @ApiForbiddenResponse({
    description:
      'Only the owner may change roles; the owner role is not assignable.',
  })
  @ApiNotFoundResponse({ description: 'That member is not in this group.' })
  changeMemberRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ChangeMemberRoleDto,
  ) {
    return this.messagingService.changeMemberRole(
      id,
      user.userId,
      userId,
      dto.role,
    );
  }

  /**
   * Transfer group ownership (DES-228, OWNER only, service re-checks). The
   * target becomes `owner`; the caller (the outgoing owner) becomes `admin`.
   */
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post(':id/owner')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Transfer group ownership to an active member (owner only)',
  })
  @ApiOkResponse({ description: 'The updated group conversation.' })
  @ApiBadRequestResponse({
    description: 'Not a group, or the caller is already the owner.',
  })
  @ApiForbiddenResponse({
    description: 'The caller is not the group owner, or the group has ended.',
  })
  @ApiNotFoundResponse({ description: 'That member is not in this group.' })
  transferOwnership(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: TransferGroupOwnershipDto,
  ) {
    return this.messagingService.transferOwnership(id, user.userId, dto.userId);
  }

  /**
   * End a group for everyone (PRD-357, OWNER only, service re-checks). Every
   * active participant (including the owner) is severed with `leftReason:
   * 'dissolved'`; the group becomes permanently read-only.
   */
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post(':id/dissolve')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Dissolve (end) a group for everyone (owner only)' })
  @ApiOkResponse({ description: 'The now-dissolved group conversation.' })
  @ApiForbiddenResponse({
    description:
      'The caller is not the group owner, or the group has already ended.',
  })
  dissolve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.dissolveGroup(id, user.userId);
  }

  /**
   * Create or ROTATE the group's join-by-link token (PRD-358, owner/admin;
   * service re-checks). Rotating invalidates whichever token was live.
   */
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post(':id/invite-link')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Create or rotate a group invite link (owner/admin only)',
  })
  @ApiOkResponse({ description: 'The new invite token.' })
  @ApiForbiddenResponse({
    description:
      'The caller is not a group owner/admin, or the group has ended.',
  })
  createInviteLink(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<{ inviteToken: string }> {
    return this.messagingService.createOrRotateInviteLink(id, user.userId);
  }

  /**
   * Disable the group's join-by-link, if any (owner/admin; service
   * re-checks). ENG-237: deliberately NOT `NotRestrictedGuard`-gated, like
   * `leave`/`decline`: turning a link OFF is closing a door, never opening
   * one, so a restricted member who is also an owner/admin can still do it.
   */
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Delete(':id/invite-link')
  @HttpCode(204)
  @ApiOperation({ summary: 'Disable the group invite link (owner/admin only)' })
  @ApiOkResponse({ description: 'The invite link is disabled.' })
  @ApiForbiddenResponse({
    description:
      'The caller is not a group owner/admin, or the group has ended.',
  })
  async disableInviteLink(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<void> {
    await this.messagingService.disableInviteLink(id, user.userId);
  }

  /** Revoke a pending group invite before it is answered (owner/admin only). */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Delete(':id/invites/:inviteId')
  @HttpCode(204)
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Revoke a pending group invite (owner/admin only)' })
  @ApiOkResponse({ description: 'The invite is revoked.' })
  @ApiForbiddenResponse({
    description: 'The caller is not a group owner/admin.',
  })
  @ApiNotFoundResponse({ description: 'That invite no longer exists.' })
  async revokeGroupInvite(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<void> {
    await this.messagingService.revokeGroupInvite(id, inviteId, user.userId);
  }

  @Get(':id/messages')
  @ApiOperation({
    summary:
      'Fetch a page of thread history (keyset-paginated; reconnect sync)',
  })
  @ApiOkResponse({
    description:
      "Backward paging (default, `cursor` or `before`/`beforeId`): `{ data, pageInfo: { nextCursor, hasMore } }`, newest-first; pass `nextCursor` back as `cursor` for the older page. Forward reconcile (`after`/`afterId`): a bare array, oldest-first. Both are floored by the caller's clear point and ceilinged at a group leave; moderator-taken-down messages render as tombstones.",
  })
  @ApiForbiddenResponse({
    description: 'The caller is not a participant of this conversation.',
  })
  messages(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Query() query: GetMessagesQuery,
  ): Promise<MessageHistoryPage | MessageResponse[]> {
    return this.messagingService.getMessages(id, user.userId, {
      before: query.before,
      beforeId: query.beforeId,
      after: query.after,
      afterId: query.afterId,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  /**
   * PRD-373: the conversation's media, links or documents gallery, newest
   * first, in the same envelope and message shape as thread history. Floored
   * by the caller's clear point, ceilinged at a group leave, and filtered of
   * their own hides; deleted and moderator-taken-down messages are left out.
   */
  @Get(':id/media')
  @ApiOperation({
    summary:
      "List a conversation's media, links or documents (keyset-paginated)",
  })
  @ApiOkResponse({
    description:
      '`{ data, pageInfo: { nextCursor, hasMore } }`, newest first; pass `nextCursor` back as `cursor` for the older page. `kind=media` is images and GIFs, `kind=links` is text messages whose body carries an http(s) address or a bare www. host, `kind=documents` is document attachments.',
  })
  @ApiForbiddenResponse({
    description: 'The caller is not a participant of this conversation.',
  })
  media(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListConversationMediaQuery,
  ): Promise<MessageHistoryPage> {
    return this.conversationMediaService.listConversationMedia(
      id,
      user.userId,
      { kind: query.kind, cursor: query.cursor, limit: query.limit },
    );
  }

  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Post(':id/messages')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Send a message to a conversation' })
  @ApiCreatedResponse({
    description:
      'The newly stored message (a fresh clientMessageId, not seen before).',
  })
  @ApiOkResponse({
    description:
      'ENG-222: an idempotent replay of a clientMessageId already stored for this conversation. The body is the SAME message unchanged; the Idempotent-Replayed header marks it as a replay rather than a new send.',
    headers: {
      'Idempotent-Replayed': {
        description: 'Present and set to "true" only on a replay response.',
        schema: { type: 'string', example: 'true' },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid body (e.g. a gif message missing its attachment).',
  })
  @ApiForbiddenResponse({
    description:
      'Not a participant, has left the group, is blocked, is not a connected member, or is under an active moderation restriction.',
  })
  @ApiNotFoundResponse({
    description: 'The conversation or the replied-to message was not found.',
  })
  async send(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: SendMessageDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    // ENG-222: `sendMessageWithOutcome` surfaces `isNew` alongside the same
    // `MessageResponse` body `sendMessage` always returned, so a replay of an
    // already-stored `clientMessageId` can be told apart from a fresh create.
    // Nest defaults a `@Post` to 201, so only the replay branch below needs
    // to touch the status; a fresh create falls through unchanged.
    const { response: messageResponse, isNew } =
      await this.messagingService.sendMessageWithOutcome(
        id,
        user.userId,
        dto.body,
        dto.replyToId,
        dto.clientMessageId,
        dto.forwarded,
        dto.kind,
        dto.attachment,
      );
    if (!isNew) {
      response.status(200);
      response.setHeader('Idempotent-Replayed', 'true');
    }
    return messageResponse;
  }

  @Get(':id/pins')
  @ApiOperation({ summary: 'List the pinned messages of a conversation' })
  @ApiOkResponse({ description: "The conversation's pinned messages." })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  pins(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.listPinnedMessages(id, user.userId);
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Post(':id/messages/:messageId/pin')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Pin a message in a conversation' })
  @ApiCreatedResponse({ description: 'The message is pinned.' })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  @ApiNotFoundResponse({
    description: 'The conversation or message was not found.',
  })
  pin(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.pinMessage(id, messageId, user.userId);
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Delete(':id/messages/:messageId/pin')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Unpin a message in a conversation' })
  @ApiOkResponse({ description: 'The message is no longer pinned.' })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  @ApiNotFoundResponse({
    description: 'The conversation or message was not found.',
  })
  unpin(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.unpinMessage(id, messageId, user.userId);
  }

  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Post(':id/messages/:messageId/star')
  @ApiOperation({ summary: 'Privately star (bookmark) a message' })
  @ApiCreatedResponse({ description: 'The message is starred for the caller.' })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  @ApiNotFoundResponse({
    description: 'The conversation or message was not found.',
  })
  star(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.starMessage(id, messageId, user.userId);
  }

  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Delete(':id/messages/:messageId/star')
  @ApiOperation({ summary: 'Remove a private star from a message' })
  @ApiOkResponse({
    description: 'The message is no longer starred for the caller.',
  })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  @ApiNotFoundResponse({
    description: 'The conversation or message was not found.',
  })
  unstar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.unstarMessage(id, messageId, user.userId);
  }

  @Post(':id/read')
  @ApiOperation({
    summary:
      "Mark a conversation read up to the caller's latest received message",
  })
  @ApiOkResponse({ description: "The caller's read watermark was advanced." })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  @ApiNotFoundResponse({
    description: '`upToMessageId` is not a message in this conversation.',
  })
  read(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    // Optional body — see `MarkReadDto`. An empty body keeps the original
    // "read up to now" behaviour, so a client that sends none still works.
    @Body() dto: MarkReadDto,
  ) {
    return this.messagingService.markRead(id, user.userId, {
      upToMessageId: dto.upToMessageId,
      lastReadAt: dto.lastReadAt,
    });
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Delete(':id')
  @ApiOperation({
    summary: 'Clear ("delete for me") a conversation from the caller\'s inbox',
  })
  @ApiOkResponse({
    description:
      'The conversation is cleared for the caller (their history floor advances); the other participant is unaffected.',
  })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  clear(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.clearConversation(id, user.userId);
  }

  /**
   * PATCH a conversation. `muted`/`pinned`/`favorite`/`archived`/`markUnread`
   * set this caller's per-conversation preferences (any thread); `mutedUntil`
   * (PRD-349) rides alongside `muted` for a TIMED mute (an ISO timestamp,
   * `null` for "Always", or omitted to leave an existing expiry alone);
   * `muteMode` (PRD-349) is a second, independent mute axis (`'all'` \|
   * `'mentionsOnly'`) that never touches `muted`/`mutedUntil` and vice versa;
   * `draft` syncs this caller's own unsent composer text. `title`/`avatarUrl`/
   * `description` edit a GROUP's info; owner/admin-gated in the service, which
   * posts a `group_renamed`/`group_photo_changed`/`group_description_changed`
   * pill per changed field.
   */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Patch(':id')
  @ApiOperation({
    summary:
      "Update a conversation: this caller's mute (with an optional timed expiry)/pin/favorite/archive/draft, or a group's title/avatar",
  })
  @ApiOkResponse({ description: 'The updated conversation.' })
  @ApiBadRequestResponse({
    description:
      'Nothing to update, not a group for a title/avatar change, or `mutedUntil` is not a future timestamp within the maximum mute duration.',
  })
  @ApiForbiddenResponse({
    description:
      'Not a participant, or not owner/admin for a group info change.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateConversationDto,
  ) {
    if (
      dto.title !== undefined ||
      dto.avatarUrl !== undefined ||
      dto.description !== undefined
    ) {
      // ENG-237: this PATCH is shared with the caller's own mute/pin/
      // favorite/archive/draft prefs below, which must stay open for a
      // restricted member (they reach only the caller). A title/avatar/
      // description change reaches every other member, so it gets the same
      // refusal `NotRestrictedGuard` gives the other group write routes,
      // checked here rather than at the method level so the branch below is
      // unaffected. `description` MUST stay in this condition: a
      // description-only PATCH that fell through to the branch below would
      // 400 with "Nothing to update" instead of reaching `updateGroup`.
      assertNotRestricted(user);
      return this.messagingService.updateGroup(id, user.userId, {
        title: dto.title,
        avatarUrl: dto.avatarUrl,
        description: dto.description,
      });
    }
    // Per-caller preferences: mute, mute mode, pin, favorite, archive, draft.
    // A single PATCH may carry one or more; each provided field is applied
    // (and awaited) in turn — so a pin-cap ConflictException from setPinned
    // propagates as a real 409 rather than a floating rejection. Nothing
    // provided -> 400.
    if (
      dto.muted === undefined &&
      dto.muteMode === undefined &&
      dto.pinned === undefined &&
      dto.favorite === undefined &&
      dto.archived === undefined &&
      dto.markUnread === undefined &&
      dto.draft === undefined
    ) {
      throw new BadRequestException('Nothing to update');
    }
    let result: { ok: true } = { ok: true };
    if (dto.muted !== undefined) {
      // PRD-349: `mutedUntil` only ever accompanies `muted`. The row/
      // conversation menu always sends both together when a duration is
      // picked (see `dto.mutedUntil`'s own doc for its three shapes).
      result = await this.messagingService.setMuted(
        id,
        user.userId,
        dto.muted,
        dto.mutedUntil,
      );
    }
    if (dto.muteMode !== undefined) {
      // PRD-349: the mute MODE is a second, independent axis from `muted`/
      // `mutedUntil` above (see `ConversationParticipant.muteMode`'s own doc).
      // Picking "Mentions only" never touches `muted`/`mutedUntil`, and a
      // timed-mute PATCH never touches this column either.
      result = await this.messagingService.setMuteMode(
        id,
        user.userId,
        dto.muteMode,
      );
    }
    if (dto.pinned !== undefined) {
      result = await this.messagingService.setPinned(
        id,
        user.userId,
        dto.pinned,
      );
    }
    if (dto.favorite !== undefined) {
      result = await this.messagingService.setFavorite(
        id,
        user.userId,
        dto.favorite,
      );
    }
    if (dto.archived !== undefined) {
      result = await this.messagingService.setArchived(
        id,
        user.userId,
        dto.archived,
      );
    }
    if (dto.markUnread !== undefined) {
      result = await this.messagingService.setMarkedUnread(
        id,
        user.userId,
        dto.markUnread,
      );
    }
    if (dto.draft !== undefined) {
      result = await this.messagingService.setDraft(id, user.userId, dto.draft);
    }
    return result;
  }

  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Post(':id/messages/:messageId/reactions')
  @ApiOperation({ summary: 'Add an emoji reaction to a message' })
  @ApiCreatedResponse({ description: 'The reaction was recorded.' })
  @ApiBadRequestResponse({ description: 'Invalid reaction key.' })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  @ApiNotFoundResponse({
    description: 'The conversation or message was not found.',
  })
  addReaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: MessageReactionDto,
  ) {
    return this.messagingService.addMessageReaction(
      id,
      messageId,
      user.userId,
      dto.key,
    );
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Delete(':id/messages/:messageId')
  @ApiOperation({
    summary:
      'Soft-delete a message (author or platform staff), leaving a tombstone',
  })
  @ApiOkResponse({
    description:
      'The message is tombstoned (idempotent on an already-deleted message).',
  })
  @ApiForbiddenResponse({
    description: 'The caller is neither the author nor platform staff.',
  })
  @ApiNotFoundResponse({
    description: 'The conversation or message was not found.',
  })
  @ApiBadRequestResponse({
    description:
      'A staff delete cited a reportId that is not about this message (code REPORT_SUBJECT_MISMATCH).',
  })
  deleteMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
    // ENG-245: optional reason/note/report for the staff audit row. Ignored on
    // an author's own delete; an empty body stays valid for every client.
    @Body() dto: DeleteMessageDto,
  ) {
    return this.messagingService.deleteMessage(id, messageId, user.userId, dto);
  }

  /**
   * "Delete for me" (PRD-227): hide ONE message from the caller's own view
   * only. Any participant may do this (not just the author) — SITS BESIDE
   * the "for everyone" tombstone above and never touches it. The other
   * participant's copy of the message, and the thread's shared pin state,
   * are completely unaffected.
   */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Delete(':id/messages/:messageId/for-me')
  @ApiOperation({
    summary:
      'Hide a message from the caller\'s own view only ("delete for me")',
  })
  @ApiOkResponse({
    description:
      "The message no longer exists in the caller's own view (idempotent). The other participant's view is unaffected.",
  })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  @ApiNotFoundResponse({
    description: 'The conversation or message was not found.',
  })
  deleteMessageForMe(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.hideMessageForMe(id, messageId, user.userId);
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Patch(':id/messages/:messageId')
  @ApiOperation({
    summary: 'Edit a message body (author only, within the 15-minute window)',
  })
  @ApiOkResponse({ description: 'The edited message.' })
  @ApiBadRequestResponse({ description: 'Invalid body.' })
  @ApiForbiddenResponse({
    description:
      'The caller is not the author, or the edit window has expired.',
  })
  @ApiNotFoundResponse({
    description: 'The message was not found (or has been deleted).',
  })
  editMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: EditMessageDto,
  ) {
    return this.messagingService.editMessage(
      id,
      messageId,
      user.userId,
      dto.body,
    );
  }

  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Delete(':id/messages/:messageId/reactions/:key')
  @ApiOperation({
    summary: "Remove the caller's emoji reaction from a message",
  })
  @ApiOkResponse({ description: 'The reaction was removed.' })
  @ApiBadRequestResponse({ description: 'Invalid reaction key.' })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  @ApiNotFoundResponse({
    description: 'The conversation or message was not found.',
  })
  removeReaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Param('key', new ParseEnumPipe(MessageReactionKey))
    key: MessageReactionKey,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.removeMessageReaction(
      id,
      messageId,
      user.userId,
      key,
    );
  }

  /**
   * "Who reacted" (PRD-352): the members behind one message's reaction counts,
   * fetched lazily by the reactions sheet so `MessageResponse` never carries
   * them. A read, so no `NotRestrictedGuard` (the reaction routes beside it
   * carry none either). See `MessageAnnotationsService.listMessageReactors`
   * for the visibility rules.
   */
  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Get(':id/messages/:messageId/reactions')
  @ApiOperation({ summary: 'List the members who reacted to a message' })
  @ApiOkResponse({
    description:
      "The reactors, the caller's own first, capped at 200 (`MessageReactorsResponse`).",
  })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  @ApiNotFoundResponse({
    description:
      'The conversation or message was not found, or the caller cannot see the message.',
  })
  listReactors(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<MessageReactorsResponse> {
    return this.messagingService.listMessageReactors(
      id,
      messageId,
      user.userId,
    );
  }
}

@Feature('messaging')
@ApiTags('Messaging')
@ApiCookieAuth()
@ApiUnauthorizedResponse({
  description: 'Not authenticated as an active member.',
})
@Controller('messages')
@UseGuards(ActiveMemberGuard)
export class MessageRequestController {
  constructor(private readonly messagingService: MessagingService) {}

  /**
   * Cross-inbox message search. Scoped server-side to the caller's own
   * conversations and floored by their `clearedAt` (see
   * `MessagingService.searchMessages`); throttled a touch tighter than reads
   * since it fans out across the caller's whole corpus.
   */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Get('search')
  @ApiOperation({
    summary: "Search the caller's own messages across all their conversations",
  })
  @ApiOkResponse({
    description:
      "Search hits (snippets + sender + conversation grouping), floored by the caller's clear point; moderator-taken-down messages are excluded.",
  })
  search(
    @CurrentUser() user: CurrentUserData,
    @Query() query: SearchMessagesQuery,
  ) {
    return this.messagingService.searchMessages(
      user.userId,
      query.q,
      query.limit,
      query.conversationId,
    );
  }

  /**
   * The caller's starred (privately-bookmarked) messages, newest-star-first.
   * Scoped server-side to the caller's own stars and their conversations, and
   * floored by `clearedAt` (see `MessagingService.listStarredMessages`).
   *
   * PRD-374: `q`/`type`/`cursor` all pass straight through to the service,
   * which is where every guard and matching rule actually lives. Throttled
   * well above the read-endpoint default of 30/60s: an active search here is
   * a debounced keystroke stream plus "Load more" taps, both routine
   * behaviour within one minute of normal typing, well short of what a
   * search-abuse cap is meant to catch.
   */
  @Throttle({ default: { limit: 120, ttl: seconds(60) } })
  @Get('starred')
  @ApiOperation({
    summary:
      "The caller's starred (privately-bookmarked) messages, newest first",
  })
  @ApiOkResponse({ description: "The caller's starred messages." })
  starred(
    @CurrentUser() user: CurrentUserData,
    @Query() query: StarredMessagesQuery,
  ) {
    return this.messagingService.listStarredMessages(user.userId, {
      limit: query.limit,
      q: query.q,
      type: query.type,
      cursor: query.cursor,
    });
  }

  @Throttle({ default: { limit: 15, ttl: seconds(60) } })
  @Post('request')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Send a first-contact message request to a member by handle',
  })
  @ApiCreatedResponse({
    description: 'The request was delivered (the conversation id is returned).',
  })
  @ApiBadRequestResponse({
    description: 'Invalid body, or the recipient is the caller.',
  })
  @ApiForbiddenResponse({
    description:
      'The recipient has blocked the caller (or vice versa), or the caller is under an active moderation restriction.',
  })
  @ApiNotFoundResponse({ description: 'The recipient handle does not exist.' })
  request(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: MessageRequestDto,
  ) {
    return this.messagingService.messageRequest(
      user.userId,
      dto.toSlug,
      dto.body,
    );
  }
}

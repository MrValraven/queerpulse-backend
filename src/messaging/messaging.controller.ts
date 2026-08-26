import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
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
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { AddMembersDto } from './dto/add-members.dto';
import { ChangeMemberRoleDto } from './dto/change-member-role.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CreateGroupConversationDto } from './dto/create-group.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { GetMessagesQuery } from './dto/get-messages.query';
import { MarkReadDto } from './dto/mark-read.dto';
import { MessageReactionDto } from './dto/message-reaction.dto';
import { MessageRequestDto } from './dto/message-request.dto';
import { SearchMessagesQuery } from './dto/search-messages.query';
import { SendMessageDto } from './dto/send-message.dto';
import { StarredMessagesQuery } from './dto/starred-messages.query';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { MessageReactionKey } from './entities/message-reaction.entity';
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

@Feature('messaging')
@ApiTags('Messaging')
@ApiCookieAuth()
@ApiUnauthorizedResponse({
  description: 'Not authenticated as an active member.',
})
@Controller('conversations')
@UseGuards(ActiveMemberGuard)
export class ConversationsController {
  constructor(private readonly messagingService: MessagingService) {}

  @Get()
  @ApiOperation({
    summary: "List the caller's conversations (inbox), newest activity first",
  })
  @ApiOkResponse({
    description:
      "The caller's conversations with last-message previews and unread counts.",
  })
  list(@CurrentUser() user: CurrentUserData) {
    return this.messagingService.listConversations(user.userId);
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
      'The two members are not connected, or one has blocked the other, or the caller is under an active moderation restriction.',
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

  @Get(':id/messages')
  @ApiOperation({
    summary:
      'Fetch a page of thread history (keyset-paginated; reconnect sync)',
  })
  @ApiOkResponse({
    description:
      "A page of messages, floored by the caller's clear point. Moderator-taken-down messages render as tombstones.",
  })
  @ApiForbiddenResponse({
    description: 'The caller is not a participant of this conversation.',
  })
  messages(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Query() query: GetMessagesQuery,
  ) {
    return this.messagingService.getMessages(id, user.userId, {
      before: query.before,
      beforeId: query.beforeId,
      after: query.after,
      afterId: query.afterId,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Post(':id/messages')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Send a message to a conversation' })
  @ApiCreatedResponse({
    description:
      'The stored message (idempotent on clientMessageId — a retry returns the same message).',
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
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: SendMessageDto,
  ) {
    return this.messagingService.sendMessage(
      id,
      user.userId,
      dto.body,
      dto.replyToId,
      dto.clientMessageId,
      dto.forwarded,
      dto.kind,
      dto.attachment,
    );
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
   * PATCH a conversation. `muted`/`pinned`/`favorite`/`archived` set this
   * caller's per-conversation preferences (any thread); `draft` syncs this
   * caller's own unsent composer text. `title`/`avatarUrl` edit a GROUP's info
   * — owner/admin-gated in the service, which posts a `group_renamed` pill on a
   * title change.
   */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Patch(':id')
  @ApiOperation({
    summary:
      "Update a conversation: this caller's mute/pin/favorite/archive/draft, or a group's title/avatar",
  })
  @ApiOkResponse({ description: 'The updated conversation.' })
  @ApiBadRequestResponse({
    description: 'Nothing to update, or not a group for a title/avatar change.',
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
    if (dto.title !== undefined || dto.avatarUrl !== undefined) {
      return this.messagingService.updateGroup(id, user.userId, {
        title: dto.title,
        avatarUrl: dto.avatarUrl,
      });
    }
    // Per-caller preferences: mute, pin, favorite, archive, draft. A single
    // PATCH may carry one or more; each provided field is applied (and
    // awaited) in turn — so a pin-cap ConflictException from setPinned
    // propagates as a real 409 rather than a floating rejection. Nothing
    // provided -> 400.
    if (
      dto.muted === undefined &&
      dto.pinned === undefined &&
      dto.favorite === undefined &&
      dto.archived === undefined &&
      dto.draft === undefined
    ) {
      throw new BadRequestException('Nothing to update');
    }
    let result: { ok: true } = { ok: true };
    if (dto.muted !== undefined) {
      result = await this.messagingService.setMuted(id, user.userId, dto.muted);
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
  deleteMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.deleteMessage(id, messageId, user.userId);
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
   */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
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
    return this.messagingService.listStarredMessages(user.userId, query.limit);
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

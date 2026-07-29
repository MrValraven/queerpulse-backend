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
import { Feature } from '../common/feature.decorator';
import { AddMembersDto } from './dto/add-members.dto';
import { ChangeMemberRoleDto } from './dto/change-member-role.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CreateGroupDto } from './dto/create-group.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { GetMessagesQuery } from './dto/get-messages.query';
import { MessageReactionDto } from './dto/message-reaction.dto';
import { MessageRequestDto } from './dto/message-request.dto';
import { SearchMessagesQuery } from './dto/search-messages.query';
import { SendMessageDto } from './dto/send-message.dto';
import { StarredMessagesQuery } from './dto/starred-messages.query';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { MessageReactionKey } from './entities/message-reaction.entity';
import { MessagingService } from './messaging.service';
import { Throttle, seconds } from '@nestjs/throttler';

@Feature('messaging')
@Controller('conversations')
@UseGuards(ActiveMemberGuard)
export class ConversationsController {
  constructor(private readonly messagingService: MessagingService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData) {
    return this.messagingService.listConversations(user.userId);
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Post()
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
  createGroup(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateGroupDto,
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
    );
  }

  @Get(':id/pins')
  pins(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.listPinnedMessages(id, user.userId);
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Post(':id/messages/:messageId/pin')
  pin(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.pinMessage(id, messageId, user.userId);
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Delete(':id/messages/:messageId/pin')
  unpin(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.unpinMessage(id, messageId, user.userId);
  }

  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Post(':id/messages/:messageId/star')
  star(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.starMessage(id, messageId, user.userId);
  }

  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Delete(':id/messages/:messageId/star')
  unstar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.unstarMessage(id, messageId, user.userId);
  }

  @Post(':id/read')
  read(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.markRead(id, user.userId);
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Delete(':id')
  clear(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.clearConversation(id, user.userId);
  }

  /**
   * PATCH a conversation. `muted` sets this caller's per-conversation preference
   * (any thread). `title`/`avatarUrl` edit a GROUP's info — owner/admin-gated in
   * the service, which posts a `group_renamed` pill on a title change.
   */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Patch(':id')
  update(
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
    if (dto.muted === undefined) {
      throw new BadRequestException('Nothing to update');
    }
    return this.messagingService.setMuted(id, user.userId, dto.muted);
  }

  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Post(':id/messages/:messageId/reactions')
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
  deleteMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.deleteMessage(id, messageId, user.userId);
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Patch(':id/messages/:messageId')
  editMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: EditMessageDto,
  ) {
    return this.messagingService.editMessage(id, messageId, user.userId, dto.body);
  }

  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Delete(':id/messages/:messageId/reactions/:key')
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
  search(
    @CurrentUser() user: CurrentUserData,
    @Query() query: SearchMessagesQuery,
  ) {
    return this.messagingService.searchMessages(
      user.userId,
      query.q,
      query.limit,
    );
  }

  /**
   * The caller's starred (privately-bookmarked) messages, newest-star-first.
   * Scoped server-side to the caller's own stars and their conversations, and
   * floored by `clearedAt` (see `MessagingService.listStarredMessages`).
   */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Get('starred')
  starred(
    @CurrentUser() user: CurrentUserData,
    @Query() query: StarredMessagesQuery,
  ) {
    return this.messagingService.listStarredMessages(user.userId, query.limit);
  }

  @Throttle({ default: { limit: 15, ttl: seconds(60) } })
  @Post('request')
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

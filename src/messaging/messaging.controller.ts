import {
  Body,
  Controller,
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
import { GetMessagesQuery } from './dto/get-messages.query';
import { MessageRequestDto } from './dto/message-request.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
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

  @Get(':id/messages')
  messages(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Query() query: GetMessagesQuery,
  ) {
    return this.messagingService.getMessages(id, user.userId, {
      before: query.before,
      beforeId: query.beforeId,
      limit: query.limit,
    });
  }

  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Post(':id/messages')
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: SendMessageDto,
  ) {
    return this.messagingService.sendMessage(id, user.userId, dto.body);
  }

  @Post(':id/read')
  read(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.messagingService.markRead(id, user.userId);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.messagingService.setMuted(id, user.userId, dto.muted);
  }
}

@Feature('messaging')
@Controller('messages')
@UseGuards(ActiveMemberGuard)
export class MessageRequestController {
  constructor(private readonly messagingService: MessagingService) {}

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

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessagingModule } from '../messaging/messaging.module';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { AdminOfficialMessagesController } from './admin-official-messages.controller';
import { OfficialBroadcast } from './entities/official-broadcast.entity';
import { OfficialBroadcastsService } from './official-broadcasts.service';
import { OfficialConversationsService } from './official-conversations.service';
import { OfficialRecipientsService } from './official-recipients.service';

/**
 * PRD-372: official conversations and broadcasts, Admin only.
 *
 * A module of its own, so `messaging.module.ts` stays untouched: it needs
 * `User`, `Profile` and `ModAuditLog` repositories that module does not
 * register, and several tasks edit `messaging.module.ts` at once. It depends on
 * `MessagingModule` (for `MessagingCoreService.postMessage`, the one write
 * path) and nothing depends on it, so no cycle is possible. Overlapping
 * `forFeature` registration is permitted (same precedent as AdminBotsModule).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OfficialBroadcast, ModAuditLog, Profile, User]),
    UsersModule,
    MessagingModule,
  ],
  controllers: [AdminOfficialMessagesController],
  providers: [
    OfficialConversationsService,
    OfficialBroadcastsService,
    OfficialRecipientsService,
  ],
  exports: [OfficialConversationsService],
})
export class OfficialMessagesModule {}

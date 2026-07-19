import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { Invite } from './entities/invite.entity';
import { JoinRequest } from './entities/join-request.entity';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { JoinRequestsController } from './join-requests.controller';
import { JoinRequestsService } from './join-requests.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Invite, JoinRequest]),
    UsersModule,
    PlatformSettingsModule,
  ],
  controllers: [InvitesController, JoinRequestsController],
  providers: [InvitesService, JoinRequestsService],
  exports: [InvitesService],
})
export class MembershipModule {}

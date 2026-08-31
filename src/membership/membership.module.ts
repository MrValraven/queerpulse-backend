import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { RecognitionEntitlementsModule } from '../recognition/recognition-entitlements.module';
import { Invite } from './entities/invite.entity';
import { PlatformJoinRequest } from './entities/join-request.entity';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { InviteExpirySweeperService } from './invite-expiry-sweeper.service';
import { AdminJoinRequestsController } from './admin-join-requests.controller';
import { JoinRequestsController } from './join-requests.controller';
import { JoinRequestsService } from './join-requests.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Invite, PlatformJoinRequest]),
    UsersModule,
    PlatformSettingsModule,
    // SUS-04: the level-derived invite-quota bonus. Deliberately the tiny
    // entitlements module and not `RecognitionModule` — `AuthModule` imports
    // this module, and `RecognitionModule` reaches `ProfilesModule` /
    // `NotificationsModule`, so the full module would risk a cycle.
    RecognitionEntitlementsModule,
  ],
  controllers: [
    InvitesController,
    JoinRequestsController,
    AdminJoinRequestsController,
  ],
  providers: [InvitesService, InviteExpirySweeperService, JoinRequestsService],
  // JoinRequestsService is exported for ONE caller: the Google callback's
  // `invite_required` branch (`AuthController`), which asks
  // `recoverStatusTokenForVerifiedEmail` whether the address Google just
  // verified has a join request waiting, and carries the applicant to their own
  // status page instead of a "you need an invite" notice (PRD-14). AuthModule
  // already imports this module for `InvitesService`, so this adds no new edge.
  exports: [InvitesService, JoinRequestsService],
})
export class MembershipModule {}

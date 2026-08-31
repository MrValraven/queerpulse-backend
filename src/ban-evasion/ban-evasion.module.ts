import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityJoinRequest } from '../communities/entities/community-join-request.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { Invite } from '../membership/entities/invite.entity';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { BanEvasionEscalationsService } from './ban-evasion-escalations.service';
import { BanEvasionNotificationsListener } from './ban-evasion-notifications.listener';
import banEvasionConfig from './ban-evasion.config';
import { BanEvasionController } from './ban-evasion.controller';
import { BanEvasionListener } from './ban-evasion.listener';
import { BanEvasionService } from './ban-evasion.service';
import { CommunityBanEvasionController } from './community-ban-evasion.controller';
import { CommunityBanEvasionService } from './community-ban-evasion.service';
import { BanEvasionEscalation } from './entities/ban-evasion-escalation.entity';
import { RemovedAccountSignal } from './entities/removed-account-signal.entity';

@Module({
  imports: [
    // The pepper is registered as a feature namespace rather than added to the
    // root `load` array, so this module stays self-contained and app.module.ts
    // needs one line (the module import) instead of two.
    ConfigModule.forFeature(banEvasionConfig),
    // `RemovedAccountSignal` and `BanEvasionEscalation` are this module's own.
    // The rest are READ-ONLY overlapping `forFeature` registrations (TypeORM
    // permits them) rather than imports of MembershipModule / UsersModule /
    // CommunitiesModule, the same self-contained pattern `AdminInvitesModule`
    // and `AdminMembersModule` use. Nothing here writes to another module's
    // table.
    TypeOrmModule.forFeature([
      RemovedAccountSignal,
      // A community moderator handing one join request to platform staff.
      BanEvasionEscalation,
      PlatformJoinRequest,
      Invite,
      User,
      Profile,
      Community,
      // The community-scoped surface reads the queue it badges
      // (`CommunityJoinRequest`) and places the caller on the community's
      // roster (`CommunityMember`, through `resolveStaffCommunity`). Both
      // read-only from here.
      CommunityJoinRequest,
      CommunityMember,
    ]),
    // `NotificationsService`, so an escalation can reach the staff who work it
    // and its resolution can reach the moderator who asked. Plain import, the
    // same one `AdminModerationHealthModule` makes: `NotificationsModule`
    // reaches nothing here, so there is no cycle to break with `forwardRef`.
    // The two entities that fan-out needs (`User` for the platform
    // `moderator`/`admin` roster, `Community` for the slug and name) are
    // already in the read-only `forFeature` list above.
    NotificationsModule,
  ],
  controllers: [BanEvasionController, CommunityBanEvasionController],
  providers: [
    BanEvasionService,
    BanEvasionListener,
    // The narrow, one-bit, this-community-only surface. Read its doc comment
    // before touching it.
    CommunityBanEvasionService,
    // The staff queue those escalations land in, with the full assessment.
    BanEvasionEscalationsService,
    // Closes the notification loop on both halves of an escalation. A separate
    // listener rather than a call inlined into the two services above, for the
    // same reason `BanEvasionListener` is one: the write has committed, and
    // telling somebody about it must never be able to fail it.
    BanEvasionNotificationsListener,
  ],
  // Exported so a ban path can call `recordRemovedAccount` directly if the
  // event hop is ever removed. The shipped wiring is the event listener.
  exports: [BanEvasionService],
})
export class BanEvasionModule {}

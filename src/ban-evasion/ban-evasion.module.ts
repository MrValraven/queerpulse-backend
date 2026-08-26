import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { Invite } from '../membership/entities/invite.entity';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import banEvasionConfig from './ban-evasion.config';
import { BanEvasionController } from './ban-evasion.controller';
import { BanEvasionListener } from './ban-evasion.listener';
import { BanEvasionService } from './ban-evasion.service';
import { RemovedAccountSignal } from './entities/removed-account-signal.entity';

@Module({
  imports: [
    // The pepper is registered as a feature namespace rather than added to the
    // root `load` array, so this module stays self-contained and app.module.ts
    // needs one line (the module import) instead of two.
    ConfigModule.forFeature(banEvasionConfig),
    // `RemovedAccountSignal` is this module's own. The other five are READ-ONLY
    // overlapping `forFeature` registrations (TypeORM permits them) rather than
    // imports of MembershipModule / UsersModule / CommunitiesModule, the same
    // self-contained pattern `AdminInvitesModule` and `AdminMembersModule` use.
    // Nothing here writes to another module's table.
    TypeOrmModule.forFeature([
      RemovedAccountSignal,
      PlatformJoinRequest,
      Invite,
      User,
      Profile,
      Community,
    ]),
  ],
  controllers: [BanEvasionController],
  providers: [BanEvasionService, BanEvasionListener],
  // Exported so a ban path can call `recordRemovedAccount` directly if the
  // event hop is ever removed. The shipped wiring is the event listener.
  exports: [BanEvasionService],
})
export class BanEvasionModule {}

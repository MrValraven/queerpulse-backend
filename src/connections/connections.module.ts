import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification } from '../notifications/entities/notification.entity';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { VouchModule } from '../vouch/vouch.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { Connection } from './entities/connection.entity';
import { ConnectionDecline } from './entities/connection-decline.entity';
import { ConnectionNote } from './entities/connection-note.entity';

@Module({
  imports: [
    // PRD-344: `Notification` and `MemberPreferences` are registered here for
    // READ-ONLY repository access alone
    // (`ConnectionsService.requestReadFlagsByConnectionId`), NOT
    // `NotificationsModule`/`PreferencesModule` themselves.
    // `TypeOrmModule.forFeature` scopes a repository provider to THIS module
    // regardless of which other modules also register the same entity.
    // Deliberately not `PreferencesService`: it transitively imports
    // `PublicEligibilityService`, which imports `ConnectionsService`, a real
    // circular require that breaks `design:paramtypes` reflection (verified).
    // A bare repository has no such cycle.
    TypeOrmModule.forFeature([
      Connection,
      ConnectionDecline,
      ConnectionNote,
      Notification,
      MemberPreferences,
    ]),
    UsersModule,
    // Exports `BlockFilterService`, used to reject a connection request when
    // either party has blocked the other (spec §2).
    SocialModule,
    // Exports `VouchService`, the single owner of the trust-graph (vouch) reads
    // the connections vouched tab / badges rely on. VouchService does not depend
    // on ConnectionsService, so this import creates no dependency cycle.
    VouchModule,
  ],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}

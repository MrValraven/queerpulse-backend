import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { VouchModule } from '../vouch/vouch.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { Connection } from './entities/connection.entity';
import { ConnectionNote } from './entities/connection-note.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Connection, ConnectionNote]),
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

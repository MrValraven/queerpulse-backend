import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { Vouch } from '../vouch/entities/vouch.entity';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { Connection } from './entities/connection.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Connection, Vouch]),
    UsersModule,
    // Exports `BlockFilterService`, used to reject a connection request when
    // either party has blocked the other (spec §2).
    SocialModule,
  ],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}

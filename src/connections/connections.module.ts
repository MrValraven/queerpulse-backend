import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { Vouch } from '../vouch/entities/vouch.entity';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { Connection } from './entities/connection.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Connection, Vouch]), UsersModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsModule } from '../connections/connections.module';
import { UsersModule } from '../users/users.module';
import { VouchModule } from '../vouch/vouch.module';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import {
  MembersController,
  ProfilesController,
} from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([SocialLink, WorkItem]),
    UsersModule,
    VouchModule,
    ConnectionsModule,
  ],
  controllers: [ProfilesController, MembersController],
  providers: [ProfilesService],
})
export class ProfilesModule {}

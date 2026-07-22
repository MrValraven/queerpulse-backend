import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessagingModule } from '../messaging/messaging.module';
import { UsersModule } from '../users/users.module';
import { FlatmateProfile } from './entities/flatmate-profile.entity';
import { FlatmateDirectoryController } from './flatmate-directory.controller';
import { FlatmateDirectoryService } from './flatmate-directory.service';
import { FlatmateProfilesController } from './flatmate-profiles.controller';
import { FlatmateProfilesService } from './flatmate-profiles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([FlatmateProfile]),
    UsersModule, // exports the Profile repository (member-ref + slug seed)
    MessagingModule, // exports MessagingService (say hello delivery)
  ],
  controllers: [FlatmateProfilesController, FlatmateDirectoryController],
  providers: [FlatmateProfilesService, FlatmateDirectoryService],
})
export class FlatmateProfilesModule {}

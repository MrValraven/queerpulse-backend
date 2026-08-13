import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessagingModule } from '../messaging/messaging.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { VerificationModule } from '../verification/verification.module';
import { AffirmingPledgeModule } from '../affirming-pledge/affirming-pledge.module';
import { FlatmateLike } from './entities/flatmate-like.entity';
import { FlatmateProfile } from './entities/flatmate-profile.entity';
import { FlatmateDirectoryController } from './flatmate-directory.controller';
import { FlatmateDirectoryService } from './flatmate-directory.service';
import { FlatmateLikesService } from './flatmate-likes.service';
import { FlatmateProfilesController } from './flatmate-profiles.controller';
import { FlatmateProfilesService } from './flatmate-profiles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([FlatmateProfile, FlatmateLike]),
    UsersModule, // exports the Profile repository (member-ref + slug seed)
    MessagingModule, // exports MessagingService (say hello delivery)
    SocialModule, // exports BlockFilterService (block severance on detail-by-slug)
    VerificationModule, // step-up gating + honest badge hydration
    AffirmingPledgeModule, // mandatory LGBTQ+ affirming pledge gate (upsert/hello)
  ],
  controllers: [FlatmateProfilesController, FlatmateDirectoryController],
  providers: [
    FlatmateProfilesService,
    FlatmateDirectoryService,
    FlatmateLikesService,
  ],
})
export class FlatmateProfilesModule {}

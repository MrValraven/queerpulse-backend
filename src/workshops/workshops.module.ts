import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialModule } from '../social/social.module';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { Workshop } from './entities/workshop.entity';
import { WorkshopsController } from './workshops.controller';
import { WorkshopsService } from './workshops.service';

/**
 * `SocialModule` is imported for `BlockFilterService` (it exports only that),
 * which `WorkshopsService.list` uses to drop workshops hosted by a blocked or
 * muted member — the same wiring `ForumModule` uses.
 *
 * `Profile` is registered directly (as `jobs` does) so the service can build
 * `MemberRef`s via `MemberLookup` without depending on `ProfilesService`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Workshop, Profile]),
    UsersModule,
    SocialModule,
  ],
  controllers: [WorkshopsController],
  providers: [WorkshopsService],
  exports: [WorkshopsService],
})
export class WorkshopsModule {}

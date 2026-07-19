import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialModule } from '../social/social.module';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { WorkshopRsvp } from './entities/workshop-rsvp.entity';
import { Workshop } from './entities/workshop.entity';
import { WorkshopRsvpsService } from './workshop-rsvps.service';
import { WorkshopsController } from './workshops.controller';
import { WorkshopsService } from './workshops.service';

/**
 * `SocialModule` is imported for `BlockFilterService` (it exports only that),
 * which `WorkshopsService.list` uses to drop workshops hosted by a blocked or
 * muted member — the same wiring `ForumModule` uses.
 *
 * `Profile` is registered directly (as `jobs` does) so the service can build
 * `MemberRef`s via `MemberLookup` without depending on `ProfilesService`.
 *
 * `WorkshopRsvpsService` is a sibling provider rather than part of
 * `WorkshopsService`, mirroring how `events` keeps `RsvpService` separate: it
 * owns the transaction + row lock that closes the capacity race, and
 * `WorkshopsService` depends on it only for the derived `spotsFilled` counts.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Workshop, WorkshopRsvp, Profile]),
    UsersModule,
    SocialModule,
  ],
  controllers: [WorkshopsController],
  providers: [WorkshopsService, WorkshopRsvpsService],
  exports: [WorkshopsService, WorkshopRsvpsService],
})
export class WorkshopsModule {}

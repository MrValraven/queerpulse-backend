import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBan } from '../events/entities/event-ban.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventInvite } from '../events/entities/event-invite.entity';
import { EventLineupEntry } from '../events/entities/event-lineup-entry.entity';
import { Event } from '../events/entities/event.entity';
import { EventsModule } from '../events/events.module';
import { GoTogetherModule } from '../go-together/go-together.module';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { User } from '../users/entities/user.entity';
import { AdminMusicEventGuestsService } from './admin-music-event-guests.service';
import { AdminMusicEventProgramService } from './admin-music-event-program.service';
import { AdminMusicEventsController } from './admin-music-events.controller';
import { AdminMusicEventsService } from './admin-music-events.service';
import { HouseMusicEventScopeService } from './house-music-event-scope.service';
import { StudioArtistSearchService } from './studio-artist-search.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controller: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `LandingModule` and `HousingListingsModule`.
      UserStaffRole,

      // Every repository the five music-events providers inject, plus the
      // entities their raw reads and transactions touch.
      Event,
      EventBan,
      EventCohost,
      EventInvite,
      EventLineupEntry,
      ModAuditLog,
      Profile,
      User,
    ]),
    // Exported services: `EventsService`, the lineup, announcement, ban,
    // invite and check-in services, `RsvpService`, and Go Together's host
    // service.
    EventsModule,
    GoTogetherModule,
  ],
  controllers: [AdminMusicEventsController],
  providers: [
    HouseMusicEventScopeService,
    StudioArtistSearchService,
    AdminMusicEventsService,
    AdminMusicEventGuestsService,
    AdminMusicEventProgramService,
  ],
})
export class MusicEventsModule {}

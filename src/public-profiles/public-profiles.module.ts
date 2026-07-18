import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { SocialLink } from '../profiles/entities/social-link.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { Profile } from '../users/entities/profile.entity';
import { PublicProfilesController } from './public-profiles.controller';
import { PublicProfilesService } from './public-profiles.service';

/**
 * Kept as its own module rather than a route on `ProfilesModule`, because the
 * separation is the safety property. `ProfilesService` is the authenticated
 * read path: it injects the vouch, connections, block-filter and handles
 * services and returns `FullProfileResponse`, a shape that carries private
 * fields. Nothing in here can reach any of that — this module owns three
 * repositories, no cross-feature services, and a mapper that names every field
 * it emits. A future field added to the member-facing profile response cannot
 * arrive on the public web through a helper this module does not import.
 *
 * `MemberPreferences` is registered for the gate only. It is read as a JOIN
 * predicate in `PublicProfilesService` and never projected — see the entity's
 * own note about why no other query in the codebase joins that table.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Profile,
      SocialLink,
      WorkItem,
      MemberPreferences,
    ]),
  ],
  controllers: [PublicProfilesController],
  providers: [PublicProfilesService],
})
export class PublicProfilesModule {}

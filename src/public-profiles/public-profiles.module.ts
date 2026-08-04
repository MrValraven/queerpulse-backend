import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { Activity } from '../profiles/entities/activity.entity';
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
 * fields. Nothing in here can reach any of that — this module owns a handful of
 * read-only repositories, no cross-feature services, and a mapper that names
 * every field it emits. A future field added to the member-facing profile
 * response cannot arrive on the public web through a helper this module does not
 * import. `Activity` is read-only here and its rows are write-filtered to
 * public-visible actions before they ever exist (see the profiles
 * `ActivityListener`).
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
      // Read-only here: the newest activity rows for a published profile. Every
      // row is already write-filtered to public-visible actions (see the
      // profiles `ActivityListener`), so no gate is needed at read time.
      Activity,
      MemberPreferences,
    ]),
    // `ContentModerationService` — a moderator takedown on a `member` subject
    // 404s the published profile too, so the open web never serves a member the
    // moderators have hidden or removed.
    ContentModerationModule,
  ],
  controllers: [PublicProfilesController],
  providers: [PublicProfilesService],
})
export class PublicProfilesModule {}

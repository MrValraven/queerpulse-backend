import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { PublicEligibilityModule } from '../public-eligibility/public-eligibility.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RecognitionAward } from './entities/recognition-award.entity';
import { RecognitionLedgerEntry } from './entities/recognition-ledger-entry.entity';
import { RecognitionPerkClaim } from './entities/recognition-perk-claim.entity';
import { RecognitionStat } from './entities/recognition-stat.entity';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { ListingPublicQuestion } from '../listings/entities/listing-public-question.entity';
import { ResourceSuggestion } from '../resources/entities/resource-suggestion.entity';
import { VolunteerSignup } from '../volunteering/entities/volunteer-signup.entity';
import {
  MemberRecognitionController,
  MyRecognitionController,
} from './recognition.controller';
import { RecognitionEntitlementsModule } from './recognition-entitlements.module';
import { RecognitionService } from './recognition.service';
import { RecognitionAwardingService } from './recognition-awarding.service';
import { RecognitionListener } from './recognition.listener';

/**
 * Recognition — badges/kudos a member has earned, level + perks (spec §3
 * Tier 2 "recognition"). Always-on member data, like `profiles`: no
 * `@Feature` flag, absent from `launchedFeatures.ts` (orchestrator wires
 * this module into `app.module.ts`, not done here).
 *
 * Imports `UsersModule` for its re-exported `Profile` repository, used to
 * resolve `slug` → `userId` for `GET /profiles/:slug/recognition` (mirrors
 * `ProfilesModule`'s own import of `UsersModule` for the same reason).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RecognitionStat,
      RecognitionAward,
      RecognitionPerkClaim,
      RecognitionLedgerEntry,
      CommunityMember,
      SavedItem,
      MemberPreferences,
      // The contribution-side counts (SUS-05). Repositories only, no module
      // import: `RecognitionAwardingService` reads these three tables and
      // never calls into the volunteering / listings / resources services, so
      // there is no dependency (and no cycle) on those modules.
      VolunteerSignup,
      ListingPublicQuestion,
      ResourceSuggestion,
    ]),
    UsersModule,
    ProfilesModule,
    PublicEligibilityModule,
    NotificationsModule,
    // Re-exported so a consumer that already imports RecognitionModule gets
    // the entitlement reads too, without a second import.
    RecognitionEntitlementsModule,
  ],
  controllers: [MyRecognitionController, MemberRecognitionController],
  providers: [
    RecognitionService,
    RecognitionAwardingService,
    RecognitionListener,
  ],
  exports: [RecognitionEntitlementsModule],
})
export class RecognitionModule {}

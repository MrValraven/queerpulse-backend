import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from '../companies/entities/company.entity';
import { CompanyTeamMember } from '../companies/entities/company-team-member.entity';
import { ListingCoManager } from '../listings/entities/listing-co-manager.entity';
import { Listing } from '../listings/entities/listing.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import { IdentityBlock } from './entities/identity-block.entity';
import { IdentityStaffPreference } from './entities/identity-staff-preference.entity';
import { Identity } from './entities/identity.entity';
import { IdentityAttributionSettingsService } from './identity-attribution-settings.service';
import { IdentityAttributionService } from './identity-attribution.service';
import { IdentityMailboxSyncService } from './identity-mailbox-sync.service';
import { IdentitiesController } from './identities.controller';
import { IdentitiesService } from './identities.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Identity,
      IdentityStaffPreference,
      IdentityBlock,
      Listing,
      ListingCoManager,
      Subprofile,
      SubprofileMember,
      Company,
      CompanyTeamMember,
      // Registered as an entity only, never `UsersModule` itself, the same
      // entity-only pattern `ConversationParticipant` below uses:
      // `IdentitiesService.describeIdentities` needs a `Profile`-kind
      // identity's own display fields and nothing else `UsersModule` offers.
      Profile,
      // Registered as entities only, never `MessagingModule` itself:
      // `MessagingModule` already imports `IdentitiesModule` (for
      // `MessagingCoreService`'s profile-identity resolution), so the reverse
      // import would cycle. `IdentityMailboxSyncService` needs no other part
      // of messaging, only these two repositories: `ConversationParticipant`
      // for the seats themselves, and `Conversation` so a departing staff
      // member's claim in this mailbox can be released in the same write
      // that ends their seat. Task 15: `IdentitiesService.listMailboxesFor`
      // reads `ConversationParticipant` too, for each mailbox's unread count.
      ConversationParticipant,
      Conversation,
    ]),
  ],
  controllers: [IdentitiesController],
  providers: [
    IdentitiesService,
    IdentityAttributionService,
    IdentityAttributionSettingsService,
    IdentityMailboxSyncService,
  ],
  exports: [
    IdentitiesService,
    IdentityAttributionService,
    IdentityAttributionSettingsService,
    IdentityMailboxSyncService,
  ],
})
export class IdentitiesModule {}

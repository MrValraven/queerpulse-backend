import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from '../companies/entities/company.entity';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { IdentitiesModule } from '../identities/identities.module';
import { Message } from '../messaging/entities/message.entity';
import { MessagingModule } from '../messaging/messaging.module';
import { SocialModule } from '../social/social.module';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { CompanyContactController } from './company-contact.controller';
import { IdentityContactService } from './identity-contact.service';
import { PersonaContactController } from './persona-contact.controller';

/**
 * Task 18: the persona and company contact endpoints. A module of its own
 * because neither domain module can import `MessagingModule`:
 * `MessagingModule` reaches `SubprofilesModule` through `PreferencesModule`,
 * so the import from subprofiles would cycle. Nothing imports this module,
 * so every edge here points one way. `Subprofile`, `Company` and `Message`
 * are registered as entities only, the pattern `IdentitiesModule` uses.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Subprofile, Company, Message]),
    MessagingModule,
    IdentitiesModule,
    ContentModerationModule,
    // Fix round 1: `BlockFilterService`, for the persona page's owner-block
    // rule. `MessagingModule` already imports it, so no new edge cycles.
    SocialModule,
  ],
  controllers: [PersonaContactController, CompanyContactController],
  providers: [IdentityContactService],
})
export class IdentityContactModule {}

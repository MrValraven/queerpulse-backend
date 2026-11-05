import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofilesModule } from '../subprofiles/subprofiles.module';
import { Profile } from '../users/entities/profile.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { User } from '../users/entities/user.entity';
import { AdminLeadsController } from './admin-leads.controller';
import { LeadEntry } from './entities/lead-entry.entity';
import { Lead } from './entities/lead.entity';
import { LeadEntriesService } from './lead-entries.service';
import { LeadPersonaService } from './lead-persona.service';
import { LeadsService } from './leads.service';

/**
 * The staff leads directory at `admin/leads`: one controller and three
 * services (lead reads and writes, notes, persona search and link checks).
 * Exports nothing; no other module reads leads, and the pseudonym unlink hook
 * (`lead-persona-unlink.ts`) runs raw SQL inside the unlink transaction.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controller: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `LandingModule` and `HousingListingsModule`.
      UserStaffRole,

      // The leads tables, plus the entities the three services read and
      // write inside their transactions.
      Lead,
      LeadEntry,
      Subprofile,
      ModAuditLog,
      Profile,
      User,
    ]),
    // Exports `SubprofilePublicReadService` (the persona picker searches).
    SubprofilesModule,
    // Exports `ContentModerationService` (persona takedown states).
    ContentModerationModule,
    // Exports `MediaCropService` (avatar crops).
    MediaCropsModule,
  ],
  controllers: [AdminLeadsController],
  providers: [LeadsService, LeadEntriesService, LeadPersonaService],
})
export class LeadsModule {}

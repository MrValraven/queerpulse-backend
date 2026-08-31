import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { ReportsModule } from '../reports/reports.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { UsersModule } from '../users/users.module';
import { Vouch } from '../vouch/entities/vouch.entity';
import { VouchModule } from '../vouch/vouch.module';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { DeletionRequest } from '../account/entities/deletion-request.entity';
import { EmailSuppression } from '../account/entities/email-suppression.entity';
import { AuthModule } from '../auth/auth.module';
import { IdentityRelinkCandidate } from '../auth/entities/identity-relink-candidate.entity';
import { AdminEmailSuppressionController } from './admin-email-suppression.controller';
import { AdminIdentityService } from './admin-identity.service';
import { AdminMemberIdentityController } from './admin-identity.controller';
import { AdminMembersController } from './admin-members.controller';
import { AdminMembersService } from './admin-members.service';

@Module({
  imports: [
    // Own `forFeature` for every entity this service reads directly —
    // `Profile`/`User`/`CommunityMember` follow `AdminCommunitiesModule`'s
    // precedent of registering its own copies rather than importing
    // `UsersModule` for its repositories (TypeORM permits overlapping
    // registrations).
    // `Vouch` also needs its own registration here: `VouchModule` exports
    // only `VouchService`, not `TypeOrmModule` — see `vouch.module.ts`.
    // `ModAuditLog` likewise: `ModerationModule` exports nothing at all
    // (no `exports` array), so `Repository<ModAuditLog>` is not reachable
    // by importing it.
    // `UserStaffRole` (grant/revokeStaffRole) follows the same precedent —
    // it gets its own registration too, rather than relying on `UsersModule`.
    TypeOrmModule.forFeature([
      Profile,
      User,
      CommunityMember,
      Vouch,
      ModAuditLog,
      UserStaffRole,
      // The identity-recovery levers' own entities (PRD-06/11/13). Registered
      // here rather than by importing `AccountModule`, following the precedent
      // `AuthModule` already sets for exactly these three: `AccountModule`
      // depends on `AuthModule`, so an import in that direction would close a
      // cycle. `AdminIdentityService` reads the deactivation and deletion
      // ledgers to REFUSE work; `AccountService` still owns every write to
      // them. `IdentityRelinkCandidate` is written pending by the sign-up path
      // and decided here.
      IdentityRelinkCandidate,
      EmailSuppression,
      AccountDeactivation,
      DeletionRequest,
    ]),
    // `ReportsModule` exports `TypeOrmModule` (re-exporting its own
    // `forFeature([Report])`), so importing it is how `Repository<Report>`
    // is obtained here — same pattern `AdminCommunitiesModule` uses.
    ReportsModule,
    // `VouchModule` exports `VouchService`, which `AdminMembersService`
    // injects directly for `getVouchCounts`/`getVouchCount`.
    VouchModule,
    // `UsersModule` exports `UsersService`, injected here for the shared
    // `countAdmins` last-admin guard `updateRole` uses (also used by
    // `AccountService.deactivate`/`requestDeletion`).
    UsersModule,
    // `AuthService`, for `applyGoogleIdRelink` (the conditional `google_id`
    // write) and `revokeAllForUser` (ending every session after a re-link).
    // `AuthModule` exports it and its own import graph reaches nothing in this
    // module, so this edge closes no cycle.
    AuthModule,
  ],
  controllers: [
    AdminMembersController,
    AdminMemberIdentityController,
    AdminEmailSuppressionController,
  ],
  providers: [AdminMembersService, AdminIdentityService],
  // Exported so `MagazineModule`'s writer-application triage can grant the
  // `magazine_writer` staff role via the same `grantStaffRole` the manual
  // admin role-assignment screen uses, instead of a second mechanism.
  exports: [AdminMembersService],
})
export class AdminMembersModule {}

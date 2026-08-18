import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { ReportsModule } from '../reports/reports.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { VouchModule } from '../vouch/vouch.module';
import { AdminMembersController } from './admin-members.controller';
import { AdminMembersService } from './admin-members.service';

@Module({
  imports: [
    // Own `forFeature` for every entity this service reads directly —
    // `Profile`/`User`/`CommunityMember` follow `AdminCommunitiesModule`'s
    // precedent of registering its own copies rather than importing
    // `UsersModule` (TypeORM permits overlapping registrations).
    // `Vouch` also needs its own registration here: `VouchModule` exports
    // only `VouchService`, not `TypeOrmModule` — see `vouch.module.ts`.
    // `ModAuditLog` likewise: `ModerationModule` exports nothing at all
    // (no `exports` array), so `Repository<ModAuditLog>` is not reachable
    // by importing it.
    // `UserStaffRole` (grant/revokeStaffRole) follows the same precedent —
    // `UsersModule` isn't imported here, so it gets its own registration too.
    TypeOrmModule.forFeature([
      Profile,
      User,
      CommunityMember,
      Vouch,
      ModAuditLog,
      UserStaffRole,
    ]),
    // `ReportsModule` exports `TypeOrmModule` (re-exporting its own
    // `forFeature([Report])`), so importing it is how `Repository<Report>`
    // is obtained here — same pattern `AdminCommunitiesModule` uses.
    ReportsModule,
    // `VouchModule` exports `VouchService`, which `AdminMembersService`
    // injects directly for `getVouchCounts`/`getVouchCount`.
    VouchModule,
  ],
  controllers: [AdminMembersController],
  providers: [AdminMembersService],
  // Exported so `MagazineModule`'s writer-application triage can grant the
  // `magazine_writer` staff role via the same `grantStaffRole` the manual
  // admin role-assignment screen uses, instead of a second mechanism.
  exports: [AdminMembersService],
})
export class AdminMembersModule {}

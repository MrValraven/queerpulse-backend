import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AmbassadorStatusModule } from '../ambassadors/ambassador-status.module';
import { Invite } from '../membership/entities/invite.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { RecognitionEntitlementsModule } from '../recognition/recognition-entitlements.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { AdminInvitesController } from './admin-invites.controller';
import { AdminInvitesService } from './admin-invites.service';

@Module({
  // Registers its own `forFeature` copies of `Invite`, `Profile`, and `User`
  // (TypeORM permits overlapping registrations) rather than importing
  // MembershipModule / UsersModule — same self-contained pattern as
  // `AdminMembersModule`. `User` backs `listInviters`' quota-override lookup
  // (read-only here; the write path is `AdminMembersService.updateInviteQuota`).
  // `ModAuditLog` is registered the same overlapping way (its owner is
  // `ModerationModule`): the admin revoke writes an `invite_revoked` row and
  // the admin refresh writes an `invite_refreshed` row, each through the
  // transaction's own `EntityManager`, mirroring how `AdminMembersModule`
  // registers it for `updateRole`/`grantStaffRole`/`updateInviteQuota`.
  // `RecognitionEntitlementsModule` and `AmbassadorStatusModule` are the same
  // leaf modules `MembershipModule` imports for the level and ambassador
  // invite bonuses, so `listQuotas` computes the effective monthly limit with
  // the exact inputs enforcement uses. Neither imports anything beyond
  // TypeORM, so no cycle can close through them.
  imports: [
    TypeOrmModule.forFeature([Invite, ModAuditLog, Profile, User]),
    RecognitionEntitlementsModule,
    AmbassadorStatusModule,
  ],
  controllers: [AdminInvitesController],
  providers: [AdminInvitesService],
})
export class AdminInvitesModule {}

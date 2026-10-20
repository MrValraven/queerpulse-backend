import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ModerationModule } from '../moderation/moderation.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { AdminEarlyAccessController } from './admin-early-access.controller';
import { AdminMemberEarlyAccessController } from './admin-member-early-access.controller';
import { EarlyAccessAdminService } from './early-access-admin.service';
import { FeatureEarlyAccessGrant } from './entities/feature-early-access-grant.entity';

/**
 * The admin early-access API: the member drawer's grant and revoke, and the
 * roster page. Per-viewer access checks live in the entity-only
 * `FeatureAccessModule`. `ModerationModule` brings `ModAuditService`; nothing
 * in its import graph reaches this module, so no `forwardRef`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([FeatureEarlyAccessGrant, User, Profile]),
    ModerationModule,
  ],
  controllers: [AdminMemberEarlyAccessController, AdminEarlyAccessController],
  providers: [EarlyAccessAdminService],
})
export class EarlyAccessModule {}

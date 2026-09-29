import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunitiesModule } from '../communities/communities.module';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { MembershipCardsModule } from '../membership-cards/membership-cards.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OfficialMessagesModule } from '../official-messages/official-messages.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminAmbassadorsController } from './admin-ambassadors.controller';
import { AmbassadorCircleService } from './ambassador-circle.service';
import { AmbassadorStatusModule } from './ambassador-status.module';
import { AmbassadorsService } from './ambassadors.service';
import { AmbassadorCircle } from './entities/ambassador-circle.entity';
import { Ambassador } from './entities/ambassador.entity';
import { PlatformAmbassadorsController } from './platform-ambassadors.controller';

/**
 * The QueerPulse Ambassadors programme: the grant lifecycle, the private
 * circle it seats ambassadors in, the admin routes and the member roster.
 *
 * Plain imports, no `forwardRef`: nothing imports this module, and none of
 * `CommunitiesModule`, `MembershipCardsModule` (the circle's card programme),
 * `OfficialMessagesModule` (the house account that owns the circle) or
 * `NotificationsModule` reaches back to it. Modules that only need the cheap
 * status reads import the leaf `AmbassadorStatusModule` instead, which keeps
 * it that way. `CommunityMember` is registered again here for the circle
 * summary's head count (overlapping `forFeature` is permitted).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Ambassador,
      AmbassadorCircle,
      Community,
      CommunityMember,
      Profile,
      User,
      // Read-only, and only for `RolesOrStaffGuard` on the admin controller,
      // same as `PartnersModule`.
      UserStaffRole,
    ]),
    AmbassadorStatusModule,
    CommunitiesModule,
    MembershipCardsModule,
    OfficialMessagesModule,
    NotificationsModule,
  ],
  controllers: [AdminAmbassadorsController, PlatformAmbassadorsController],
  providers: [AmbassadorsService, AmbassadorCircleService],
})
export class AmbassadorsModule {}

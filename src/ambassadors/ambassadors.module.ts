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
 * Plain imports, no `forwardRef`: none of `CommunitiesModule`,
 * `MembershipCardsModule` (the circle's card programme),
 * `OfficialMessagesModule` (the house account that owns the circle) or
 * `NotificationsModule` reaches back to it. `AdminMembersModule` imports this
 * module for `releaseStaffSeat` (ENG-457), and nothing this module imports
 * reaches `AdminMembersModule`, so that edge closes no cycle either. Modules
 * that only need the cheap status reads import the leaf
 * `AmbassadorStatusModule` instead, which keeps it that way. `CommunityMember`
 * is registered again here for the circle summary's head count (overlapping
 * `forFeature` is permitted).
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
      // Read-only: `RolesOrStaffGuard` on the admin controller, same as
      // `PartnersModule`, and the `partnerships` check in `releaseStaffSeat`.
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
  exports: [AmbassadorsService],
})
export class AmbassadorsModule {}

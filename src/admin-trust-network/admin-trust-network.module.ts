import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Invite } from '../membership/entities/invite.entity';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { ReportsModule } from '../reports/reports.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { AdminTrustNetworkAssessmentService } from './admin-trust-network-assessment.service';
import { AdminTrustNetworkController } from './admin-trust-network.controller';
import { AdminTrustNetworkService } from './admin-trust-network.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Profile,
      User,
      CommunityMember,
      Vouch,
      Invite,
      PlatformJoinRequest,
    ]),
    ReportsModule,
  ],
  controllers: [AdminTrustNetworkController],
  providers: [AdminTrustNetworkService, AdminTrustNetworkAssessmentService],
})
export class AdminTrustNetworkModule {}

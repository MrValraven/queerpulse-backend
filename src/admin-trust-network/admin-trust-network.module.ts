import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { ReportsModule } from '../reports/reports.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { AdminTrustNetworkController } from './admin-trust-network.controller';
import { AdminTrustNetworkService } from './admin-trust-network.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Profile, User, CommunityMember, Vouch]),
    ReportsModule,
  ],
  controllers: [AdminTrustNetworkController],
  providers: [AdminTrustNetworkService],
})
export class AdminTrustNetworkModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { ReportsModule } from '../reports/reports.module';
import { Profile } from '../users/entities/profile.entity';
import { AdminCommunitiesController } from './admin-communities.controller';
import { AdminCommunitiesService } from './admin-communities.service';

@Module({
  imports: [
    // Own `forFeature` for the community-side entities (TypeORM permits
    // overlapping registrations — same precedent as `ModerationModule`), plus
    // `ReportsModule` for `Repository<Report>`, which it exports.
    TypeOrmModule.forFeature([
      Community,
      CommunityMember,
      CommunityPost,
      CommunityPostReply,
      Profile,
    ]),
    ReportsModule,
  ],
  controllers: [AdminCommunitiesController],
  providers: [AdminCommunitiesService],
})
export class AdminCommunitiesModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfilesModule } from '../profiles/profiles.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { AdminBotsController } from './admin-bots.controller';
import { AdminBotsService } from './admin-bots.service';

@Module({
  imports: [
    // Own `forFeature` for the isSystem gate plus the stored image reads that
    // back the foreign-upload check (bot avatar + work-item images) — overlapping
    // TypeORM registration is permitted (same precedent as AdminCommunitiesModule).
    TypeOrmModule.forFeature([User, Profile, WorkItem]),
    // Exports `ProfilesService`, which owns all profile write + validation logic.
    ProfilesModule,
  ],
  controllers: [AdminBotsController],
  providers: [AdminBotsService],
})
export class AdminBotsModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfilesModule } from '../profiles/profiles.module';
import { User } from '../users/entities/user.entity';
import { AdminBotsController } from './admin-bots.controller';
import { AdminBotsService } from './admin-bots.service';

@Module({
  imports: [
    // Own `forFeature([User])` for the isSystem gate — overlapping TypeORM
    // registration is permitted (same precedent as AdminCommunitiesModule).
    TypeOrmModule.forFeature([User]),
    // Exports `ProfilesService`, which owns all profile write + validation logic.
    ProfilesModule,
  ],
  controllers: [AdminBotsController],
  providers: [AdminBotsService],
})
export class AdminBotsModule {}

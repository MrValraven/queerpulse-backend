import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { Topic } from '../content/entities/topic.entity';
import { TopicFollow } from '../topics/entities/topic-follow.entity';
import { AdminTopicsController } from './admin-topics.controller';
import { AdminTopicsService } from './admin-topics.service';

/**
 * The staff authoring surface for the topic directory (SOC-01).
 *
 * A separate module rather than another controller inside `content`, matching
 * `admin-forum` / `admin-communities`: the read side stays a member-facing
 * feature module and the guarded write side lives on its own.
 *
 * Registers the two entities it writes directly (`Topic`, owned read-side by
 * `ContentModule`, and `TopicFollow`, owned by `TopicsModule`) rather than
 * importing those modules, since neither exports a repository and the only
 * shared thing needed here is the table.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,
      Topic,
      TopicFollow,
    ]),
  ],
  controllers: [AdminTopicsController],
  providers: [AdminTopicsService],
})
export class AdminTopicsModule {}

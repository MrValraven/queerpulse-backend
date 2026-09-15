import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ForumModule } from '../forum/forum.module';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminForumController } from './admin-forum.controller';
import { AdminForumService } from './admin-forum.service';

@Module({
  imports: [
    // Exports `ForumThreadsService`, which owns the thread read/write logic
    // this module delegates to.
    ForumModule,
    // Read-only, and only for `RolesOrStaffGuard` on the controller: it
    // resolves the caller's additive staff grants when their account tier alone
    // does not satisfy `@Roles(...)`. Registered here directly rather than
    // pulled in through `UsersModule`, the same registration precedent
    // `AdminModerationHealthModule` and `AdminCommunitiesModule` follow.
    //
    // The controller carries an empty `@StaffRoles()`, so today no grant can
    // actually satisfy it and this lookup never runs. It is still required: the
    // guard is constructed with the repository regardless of which decorators
    // the routes happen to carry.
    TypeOrmModule.forFeature([UserStaffRole]),
  ],
  controllers: [AdminForumController],
  providers: [AdminForumService],
})
export class AdminForumModule {}

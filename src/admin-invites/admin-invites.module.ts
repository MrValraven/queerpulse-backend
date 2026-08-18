import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Invite } from '../membership/entities/invite.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { AdminInvitesController } from './admin-invites.controller';
import { AdminInvitesService } from './admin-invites.service';

@Module({
  // Registers its own `forFeature` copies of `Invite`, `Profile`, and `User`
  // (TypeORM permits overlapping registrations) rather than importing
  // MembershipModule / UsersModule — same self-contained pattern as
  // `AdminMembersModule`. `User` backs `listInviters`' quota-override lookup
  // (read-only here; the write path is `AdminMembersService.updateInviteQuota`).
  imports: [TypeOrmModule.forFeature([Invite, Profile, User])],
  controllers: [AdminInvitesController],
  providers: [AdminInvitesService],
})
export class AdminInvitesModule {}

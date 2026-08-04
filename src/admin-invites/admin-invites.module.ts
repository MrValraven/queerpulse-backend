import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Invite } from '../membership/entities/invite.entity';
import { Profile } from '../users/entities/profile.entity';
import { AdminInvitesController } from './admin-invites.controller';
import { AdminInvitesService } from './admin-invites.service';

@Module({
  // Registers its own `forFeature` copies of `Invite` and `Profile` (TypeORM
  // permits overlapping registrations) rather than importing MembershipModule /
  // UsersModule — same self-contained pattern as `AdminMembersModule`. It only
  // reads these two, and only through `Repository<T>`.
  imports: [TypeOrmModule.forFeature([Invite, Profile])],
  controllers: [AdminInvitesController],
  providers: [AdminInvitesService],
})
export class AdminInvitesModule {}

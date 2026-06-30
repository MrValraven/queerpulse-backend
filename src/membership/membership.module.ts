import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { Invite } from './entities/invite.entity';
import { JoinRequest } from './entities/join-request.entity';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { JoinRequestsController } from './join-requests.controller';
import { JoinRequestsService } from './join-requests.service';

@Module({
  imports: [TypeOrmModule.forFeature([Invite, JoinRequest]), UsersModule],
  controllers: [InvitesController, JoinRequestsController],
  providers: [InvitesService, JoinRequestsService],
  exports: [InvitesService],
})
export class MembershipModule {}

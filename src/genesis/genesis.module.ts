import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Invite } from '../membership/entities/invite.entity';
import { MembershipModule } from '../membership/membership.module';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { GenesisController } from './genesis.controller';
import { GenesisService } from './genesis.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Invite]),
    UsersModule,
    // Exports InvitesService, whose `createInviteForApproval` mints the
    // genesis invite.
    MembershipModule,
  ],
  controllers: [GenesisController],
  providers: [GenesisService],
})
export class GenesisModule {}

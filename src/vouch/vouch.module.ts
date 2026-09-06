import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { Vouch } from './entities/vouch.entity';
import { MyVouchesController, VouchController } from './vouch.controller';
import { VouchService } from './vouch.service';

@Module({
  // `SocialModule` for `BlockFilterService`: vouching is a mutual
  // interaction, so a block either way severs it (`createVouch` refuses,
  // and every roster/count read drops the severed row). `SocialModule`
  // imports only `UsersModule`, `ReportsModule` and `forFeature`
  // registrations, none of which reach back here, so this is a plain
  // one-way import with no cycle.
  imports: [TypeOrmModule.forFeature([Vouch]), UsersModule, SocialModule],
  controllers: [VouchController, MyVouchesController],
  providers: [VouchService],
  exports: [VouchService],
})
export class VouchModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { Vouch } from './entities/vouch.entity';
import {
  MyVouchesController,
  VouchController,
} from './vouch.controller';
import { VouchService } from './vouch.service';

@Module({
  imports: [TypeOrmModule.forFeature([Vouch]), UsersModule],
  controllers: [VouchController, MyVouchesController],
  providers: [VouchService],
  exports: [VouchService],
})
export class VouchModule {}

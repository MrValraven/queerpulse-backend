import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PersonaNudge } from './entities/persona-nudge.entity';
import { NudgesController } from './nudges.controller';
import { NudgesService } from './nudges.service';

@Module({
  imports: [TypeOrmModule.forFeature([PersonaNudge])],
  controllers: [NudgesController],
  providers: [NudgesService],
})
export class NudgesModule {}

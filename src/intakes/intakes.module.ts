import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntakeSubmission } from './entities/intake-submission.entity';
import { IntakesController } from './intakes.controller';
import { IntakesService } from './intakes.service';

@Module({
  imports: [TypeOrmModule.forFeature([IntakeSubmission])],
  controllers: [IntakesController],
  providers: [IntakesService],
})
export class IntakesModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminQueueNotificationsModule } from '../admin-queue-notifications/admin-queue-notifications.module';
import { IntakeSubmission } from './entities/intake-submission.entity';
import { IntakesController } from './intakes.controller';
import { IntakesService } from './intakes.service';

@Module({
  // `Profile` backs the batched submitter lookup that enriches the admin list
  // with a name/avatar; `NotificationsModule` lets a resolved/dismissed concern
  // reach a submitter who has an account. QueerPulse delivers no email, so an
  // anonymous submitter is never reached at all.
  imports: [
    TypeOrmModule.forFeature([IntakeSubmission, Profile]),
    NotificationsModule,
    AdminQueueNotificationsModule,
  ],
  controllers: [IntakesController],
  providers: [IntakesService],
})
export class IntakesModule {}

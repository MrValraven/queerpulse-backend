import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { MailerModule } from '../mailer/mailer.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IntakeSubmission } from './entities/intake-submission.entity';
import { IntakesController } from './intakes.controller';
import { IntakesService } from './intakes.service';

@Module({
  // `Profile` backs the batched submitter lookup that enriches the admin list
  // with a name/avatar; Notifications + Mailer let a resolved/dismissed concern
  // reach its submitter (in-app for a signed-in member, email for a logged-out
  // one).
  imports: [
    TypeOrmModule.forFeature([IntakeSubmission, Profile]),
    NotificationsModule,
    MailerModule,
  ],
  controllers: [IntakesController],
  providers: [IntakesService],
})
export class IntakesModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminQueueNotificationsModule } from '../admin-queue-notifications/admin-queue-notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';
import { Inquiry } from './entities/inquiry.entity';

/**
 * Public marketing-form intake (Contact + For-Organisations partnership).
 * A submission is stored and QueerPulse delivers no email, so the admin triage
 * list is where an inquiry surfaces. A safety concern additionally rings the
 * staff bell through `AdminQueueNotificationsModule` (PRD-452).
 */
@Module({
  imports: [
    AdminQueueNotificationsModule,
    TypeOrmModule.forFeature([
      Inquiry,
      // Read-only, so the admin triage list can resolve a handler's uuid to a
      // display name through the shared `MemberLookup` without pulling
      // `ProfilesService` (and its module graph) into this small module.
      Profile,
    ]),
  ],
  controllers: [InquiriesController],
  providers: [InquiriesService],
})
export class InquiriesModule {}

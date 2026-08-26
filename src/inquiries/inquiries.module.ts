import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailerModule } from '../mailer/mailer.module';
import { Profile } from '../users/entities/profile.entity';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';
import { Inquiry } from './entities/inquiry.entity';

/**
 * Public marketing-form intake (Contact + For-Organisations partnership).
 * `MailerModule` is imported so a new inquiry pings ops via the shared,
 * env-gated mailer (log-only until SMTP is configured). `ConfigService` is
 * globally available, so no import is needed for it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Inquiry,
      // Read-only, so the admin triage list can resolve a handler's uuid to a
      // display name through the shared `MemberLookup` without pulling
      // `ProfilesService` (and its module graph) into this small module.
      Profile,
    ]),
    MailerModule,
  ],
  controllers: [InquiriesController],
  providers: [InquiriesService],
})
export class InquiriesModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailerModule } from '../mailer/mailer.module';
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
  imports: [TypeOrmModule.forFeature([Inquiry]), MailerModule],
  controllers: [InquiriesController],
  providers: [InquiriesService],
})
export class InquiriesModule {}

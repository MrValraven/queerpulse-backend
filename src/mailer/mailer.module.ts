import { Module } from '@nestjs/common';
import { MailerService } from './mailer.service';

/**
 * The transactional mailer, exported for any feature that needs to send email
 * (resume links, and future email-dependent flows). `ConfigService` is globally
 * available (`ConfigModule.forRoot({ isGlobal: true })`), so no imports are
 * needed. Registered in `AppModule`; importers get `MailerService` via `exports`.
 */
@Module({
  providers: [MailerService],
  exports: [MailerService],
})
export class MailerModule {}

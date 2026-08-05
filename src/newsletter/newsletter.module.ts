import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailerModule } from '../mailer/mailer.module';
import { NewsletterSubscription } from './entities/newsletter-subscription.entity';
import { NewsletterController } from './newsletter.controller';
import { NewsletterService } from './newsletter.service';

/**
 * Double-opt-in newsletter capture. Reuses the shared {@link MailerModule}
 * (log-only until SMTP env is set) for the confirmation email; `ConfigService`
 * is globally available.
 */
@Module({
  imports: [TypeOrmModule.forFeature([NewsletterSubscription]), MailerModule],
  controllers: [NewsletterController],
  providers: [NewsletterService],
})
export class NewsletterModule {}

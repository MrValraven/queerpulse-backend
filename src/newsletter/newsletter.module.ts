import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailerModule } from '../mailer/mailer.module';
import { NewsletterDigestBatch } from './entities/newsletter-digest-batch.entity';
import { NewsletterDigestSend } from './entities/newsletter-digest-send.entity';
import { NewsletterSubscription } from './entities/newsletter-subscription.entity';
import { NewsletterController } from './newsletter.controller';
import { NewsletterDigestService } from './newsletter-digest.service';
import { NewsletterService } from './newsletter.service';

/**
 * Double-opt-in newsletter capture, plus the members'-digest mailing queue.
 * Reuses the shared {@link MailerModule} (log-only until SMTP env is set) for
 * both the confirmation email and the digest; `ConfigService` is globally
 * available.
 *
 * {@link NewsletterDigestService} listens for the magazine module's
 * `newsletter.digest_due` event rather than being called directly, so neither
 * module has to import the other.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      NewsletterSubscription,
      NewsletterDigestBatch,
      NewsletterDigestSend,
    ]),
    MailerModule,
  ],
  controllers: [NewsletterController],
  providers: [NewsletterService, NewsletterDigestService],
})
export class NewsletterModule {}

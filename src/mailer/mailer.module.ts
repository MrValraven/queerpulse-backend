import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NewsletterSubscription } from '../newsletter/entities/newsletter-subscription.entity';
import { BulkUnsubscribeService } from './bulk-unsubscribe.service';
import { MailerService } from './mailer.service';

/**
 * The transactional mailer, exported for any feature that needs to send email
 * (resume links, and future email-dependent flows). `ConfigService` is globally
 * available (`ConfigModule.forRoot({ isGlobal: true })`). Registered in
 * `AppModule`; importers get `MailerService` via `exports`.
 *
 * Registers the `NewsletterSubscription` ENTITY directly (rather than importing
 * `NewsletterModule`) so `BulkUnsubscribeService` can resolve a recipient's
 * unsubscribe token: `NewsletterModule` already imports this module for the
 * confirmation email, so importing it back would be a cycle. Same one-way-entity
 * precedent as `SocialModule` registering `Connection`. `BulkUnsubscribeService`
 * is internal — only `MailerService` uses it, so it is not exported.
 */
@Module({
  imports: [TypeOrmModule.forFeature([NewsletterSubscription])],
  providers: [MailerService, BulkUnsubscribeService],
  exports: [MailerService],
})
export class MailerModule {}

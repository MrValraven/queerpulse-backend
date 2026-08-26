import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailerModule } from '../mailer/mailer.module';
import { NewsletterSubscription } from './entities/newsletter-subscription.entity';
import { NewsletterController } from './newsletter.controller';
import { NewsletterService } from './newsletter.service';

/**
 * Double-opt-in newsletter capture: an address, its confirmation link, and its
 * self-serve unsubscribe. Reuses the shared {@link MailerModule} (log-only
 * until SMTP env is set) for the one message this module sends, the
 * confirmation itself; `ConfigService` is globally available.
 *
 * THERE IS NO DIGEST HERE, deliberately. QueerPulse delivers no bulk mail to
 * members, so the members'-digest queue this module used to own (a
 * `newsletter.digest_due` listener, a per-subscriber ledger, and a
 * once-a-minute drain calling `mailer.send(..., 'digest', ...)`) is gone
 * entirely, along with the `digest`/`digest_test` mail templates. Shipping a
 * magazine issue now writes one in-app notification per member and publishes
 * the curated running order to the issue's public page
 * (`GET /magazine/issues/:number/contents`); nothing on that path can dispatch
 * mail.
 *
 * The `newsletter_digest_batches` / `newsletter_digest_sends` tables are left
 * in the database rather than dropped: no code reads or writes them any more,
 * and a dropped table is the one migration a rollback cannot undo.
 */
@Module({
  imports: [TypeOrmModule.forFeature([NewsletterSubscription]), MailerModule],
  controllers: [NewsletterController],
  providers: [NewsletterService],
})
export class NewsletterModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NewsletterSubscription } from './entities/newsletter-subscription.entity';
import { NewsletterController } from './newsletter.controller';
import { NewsletterService } from './newsletter.service';

/**
 * Newsletter capture: an address, its stored confirm token, and its self-serve
 * unsubscribe.
 *
 * NOTHING HERE SENDS ANYTHING. QueerPulse delivers no email, so subscribing
 * records a `pending` row and stops there; the confirm and unsubscribe routes
 * stay reachable by token for anyone handed one out of band.
 *
 * THERE IS NO DIGEST HERE, deliberately. QueerPulse delivers no bulk mail to
 * members, so the members'-digest queue this module used to own (a
 * `newsletter.digest_due` listener, a per-subscriber ledger, and a
 * once-a-minute drain over an outbound mail transport) is gone entirely, along
 * with the `digest`/`digest_test` templates. Shipping a
 * magazine issue now writes one in-app notification per member and publishes
 * the curated running order to the issue's public page
 * (`GET /magazine/issues/:number/contents`); nothing on that path can dispatch
 * mail, and no code path in this repository can.
 *
 * The `newsletter_digest_batches` / `newsletter_digest_sends` tables are left
 * in the database rather than dropped: no code reads or writes them any more,
 * and a dropped table is the one migration a rollback cannot undo.
 */
@Module({
  imports: [TypeOrmModule.forFeature([NewsletterSubscription])],
  controllers: [NewsletterController],
  providers: [NewsletterService],
})
export class NewsletterModule {}

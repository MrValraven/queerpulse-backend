import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import type {
  ConfirmResultDto,
  SubscribeResultDto,
  UnsubscribeResultDto,
} from './dto/newsletter-response.dto';
import { NewsletterSubscription } from './entities/newsletter-subscription.entity';

@Injectable()
export class NewsletterService {
  constructor(
    @InjectRepository(NewsletterSubscription)
    private readonly subscriptions: Repository<NewsletterSubscription>,
  ) {}

  /**
   * Register (or re-register) an address for the newsletter.
   *
   * Upserts a `pending` row keyed by the (lowercased) email and mints a fresh
   * confirm token. NOTHING IS DELIVERED: QueerPulse delivers no email, so no
   * confirmation link ever reaches the address and the row simply stays
   * `pending` until someone is handed its token out of band.
   * `POST /newsletter/confirm` and the unsubscribe routes stay reachable by
   * token for whoever holds one.
   *
   * The response is IDENTICAL regardless of whether the address was new,
   * already pending, previously unsubscribed, or already confirmed, so a
   * caller can never probe the list for membership. A row that is already
   * `confirmed` is left untouched, and the caller still sees the same
   * `pending`-shaped acknowledgement.
   */
  async subscribe(rawEmail: string): Promise<SubscribeResultDto> {
    const email = rawEmail.trim().toLowerCase();
    const existing = await this.subscriptions.findOne({ where: { email } });

    if (existing && existing.status === 'confirmed') {
      // Already on the list — do nothing, but return the uniform response so
      // membership never leaks through a different shape.
      return { status: 'pending' };
    }

    const confirmToken = randomBytes(32).toString('hex');
    if (existing) {
      existing.status = 'pending';
      existing.confirmToken = confirmToken;
      existing.confirmedAt = null;
      // A re-subscribe fully resets the row's lifecycle, including a prior
      // unsubscribe — otherwise a resubscribed-then-reconfirmed row would
      // still carry a stale unsubscribedAt alongside its new confirmedAt.
      existing.unsubscribedAt = null;
      await this.subscriptions.save(existing);
    } else {
      await this.subscriptions.save(
        this.subscriptions.create({ email, status: 'pending', confirmToken }),
      );
    }

    // The uniform `pending` response is still deliberate: every branch returns
    // the same shape so nobody can probe the list for membership.
    return { status: 'pending' };
  }

  /** Mark the address behind `token` confirmed. Idempotent for an already-confirmed row. */
  async confirm(token: string): Promise<ConfirmResultDto> {
    const subscription = token
      ? await this.subscriptions.findOne({ where: { confirmToken: token } })
      : null;
    if (!subscription) {
      throw new NotFoundException('Invalid or expired confirmation link.');
    }

    if (subscription.status !== 'confirmed') {
      subscription.status = 'confirmed';
      subscription.confirmedAt = new Date();
      await this.subscriptions.save(subscription);
    }
    return { status: 'confirmed' };
  }

  /**
   * Mark the address behind `token` unsubscribed (CNT-19). Reuses the same
   * `confirmToken` a fresh subscribe mints — it doubles as this row's stable
   * unsubscribe key rather than a second secret being generated for it — so
   * an invalid/unknown token is rejected exactly like `confirm`'s. The
   * platform never delivers this token anywhere; the route stays reachable for
   * anyone handed one out of band. Idempotent:
   * calling this on an already-unsubscribed row is not an error, it just
   * reports `alreadyUnsubscribed: true` instead of stamping a new timestamp.
   */
  async unsubscribe(token: string): Promise<UnsubscribeResultDto> {
    const subscription = token
      ? await this.subscriptions.findOne({ where: { confirmToken: token } })
      : null;
    if (!subscription) {
      throw new NotFoundException('Invalid or expired unsubscribe link.');
    }

    const alreadyUnsubscribed = subscription.status === 'unsubscribed';
    if (!alreadyUnsubscribed) {
      subscription.status = 'unsubscribed';
      subscription.unsubscribedAt = new Date();
      await this.subscriptions.save(subscription);
    }
    return { status: 'unsubscribed', alreadyUnsubscribed };
  }
}

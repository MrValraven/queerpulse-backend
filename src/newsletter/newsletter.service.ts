import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { MailerService } from '../mailer/mailer.service';
import type {
  ConfirmResultDto,
  SubscribeResultDto,
  UnsubscribeResultDto,
} from './dto/newsletter-response.dto';
import { NewsletterSubscription } from './entities/newsletter-subscription.entity';

@Injectable()
export class NewsletterService {
  private readonly logger = new Logger(NewsletterService.name);

  constructor(
    @InjectRepository(NewsletterSubscription)
    private readonly subscriptions: Repository<NewsletterSubscription>,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Register (or re-register) an address for the newsletter under double opt-in.
   *
   * Upserts a `pending` row keyed by the (lowercased) email and mails a fresh
   * confirmation link. The response is IDENTICAL regardless of whether the
   * address was new, already pending, previously unsubscribed, or already
   * confirmed — so a caller can never probe the list for membership. A row that
   * is already `confirmed` is left untouched and no email is re-sent, but the
   * caller still sees the same `pending`-shaped acknowledgement.
   */
  async subscribe(rawEmail: string): Promise<SubscribeResultDto> {
    const email = rawEmail.trim().toLowerCase();
    const existing = await this.subscriptions.findOne({ where: { email } });

    if (existing && existing.status === 'confirmed') {
      // Already on the list — do nothing, but return the uniform response so
      // membership never leaks through a different shape or a resent email.
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

    // Fire-and-forget, deliberately NOT awaited.
    //
    // The response body is uniform so membership can't be read off it, but
    // awaiting the send leaked the same fact through TIMING: an
    // already-confirmed address returned in tens of milliseconds (it exits
    // above without sending), while every other address paid a synchronous SMTP
    // round trip — up to the mailer's 8s connect + 8s socket timeouts against a
    // degraded host. `POST /newsletter/subscribe` was a reliable membership
    // oracle for anyone with a stopwatch, and the 5/min throttle is plenty for
    // a targeted check. Both branches now return as soon as the row is written.
    //
    // `void` (not a floating promise): `sendConfirmation` already swallows its
    // own delivery errors and logs them, so this can never reject unhandled.
    void this.sendConfirmation(email, confirmToken);
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
   * an invalid/unknown token is rejected exactly like `confirm`'s. Idempotent:
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

  /**
   * Build the confirm link and dispatch it through the shared mailer (log-only
   * until SMTP env is set). A delivery failure is logged but swallowed so the
   * subscribe response stays uniform and never depends on the mail transport.
   *
   * Called OFF the request path (`void`-ed by `subscribe`), so it must never
   * throw — see the timing-oracle note there. Anything added here has to keep
   * that guarantee.
   */
  private async sendConfirmation(
    email: string,
    confirmToken: string,
  ): Promise<void> {
    const apiUrl = this.config.getOrThrow<string>('app.apiUrl');
    const confirmUrl = new URL('/newsletter/confirm', apiUrl);
    confirmUrl.searchParams.set('token', confirmToken);
    try {
      await this.mailer.send(email, 'newsletter_confirm', {
        confirmUrl: confirmUrl.toString(),
      });
    } catch (error) {
      this.logger.error(
        `Failed to send newsletter confirmation to ${email}: ${String(error)}`,
      );
    }
  }
}

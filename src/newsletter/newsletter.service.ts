import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { MailerService } from '../mailer/mailer.service';
import type {
  ConfirmResultDto,
  SubscribeResultDto,
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
      await this.subscriptions.save(existing);
    } else {
      await this.subscriptions.save(
        this.subscriptions.create({ email, status: 'pending', confirmToken }),
      );
    }

    await this.sendConfirmation(email, confirmToken);
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
   * Build the confirm link and dispatch it through the shared mailer (log-only
   * until SMTP env is set). A delivery failure is logged but swallowed so the
   * subscribe response stays uniform and never depends on the mail transport.
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

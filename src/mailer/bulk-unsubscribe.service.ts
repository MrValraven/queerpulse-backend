import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NewsletterSubscription } from '../newsletter/entities/newsletter-subscription.entity';

/** The two forms of opt-out a bulk message has to carry. */
export interface UnsubscribeLinks {
  /**
   * RFC 8058 one-click target for the `List-Unsubscribe` header: an https URL
   * that accepts a POST with no confirmation step and no session. Gmail/Yahoo
   * bulk-sender rules have required this since 2024.
   */
  oneClickUrl: string;
  /** Human-facing page linked from the message body, opened in a browser. */
  pageUrl: string;
}

/**
 * Resolves a recipient's stable unsubscribe token so {@link MailerService} can
 * attach an opt-out to every BULK message.
 *
 * Lives in `mailer` (registering the `NewsletterSubscription` entity directly
 * rather than importing `NewsletterModule`) because `NewsletterModule` already
 * imports `MailerModule` for the confirmation email — importing it back would
 * be a cycle. Same precedent as `SocialModule` registering the `Connection`
 * entity to sever a connection edge without depending on `ConnectionsModule`.
 * This service reads one column of one table; it does not depend on
 * `NewsletterService`.
 *
 * The token is the subscriber's `confirmToken`, which the newsletter entity
 * documents as doing double duty as the unsubscribe key — no second secret is
 * minted, and rotating it on a fresh subscribe invalidates old links for free.
 */
@Injectable()
export class BulkUnsubscribeService {
  constructor(
    @InjectRepository(NewsletterSubscription)
    private readonly subscriptions: Repository<NewsletterSubscription>,
    private readonly config: ConfigService,
  ) {}

  /**
   * The opt-out links for `email`, or `null` when the address has no
   * subscription row (so no token exists to unsubscribe with). A caller
   * sending bulk mail must treat `null` as "do not send" rather than "send
   * without an opt-out" — see `MailerService.send`.
   */
  async linksFor(email: string): Promise<UnsubscribeLinks | null> {
    const row = await this.subscriptions.findOne({
      where: { email: email.trim().toLowerCase() },
    });
    if (!row?.confirmToken) {
      return null;
    }
    // The one-click POST answers on the API itself; the human page is the SPA
    // route (`routeMap.newsletterUnsubscribe`), which calls the versioned GET
    // and renders real success / already-unsubscribed / invalid states.
    const apiUrl = this.config.getOrThrow<string>('app.apiUrl');
    const frontendUrl = this.config.getOrThrow<string>('app.frontendUrl');
    const oneClickUrl = new URL('/newsletter/unsubscribe', apiUrl);
    oneClickUrl.searchParams.set('token', row.confirmToken);
    const pageUrl = new URL('/newsletter/unsubscribe', frontendUrl);
    pageUrl.searchParams.set('token', row.confirmToken);
    return {
      oneClickUrl: oneClickUrl.toString(),
      pageUrl: pageUrl.toString(),
    };
  }
}

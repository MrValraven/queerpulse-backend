import type { NewsletterDigestItem } from './entities/newsletter-digest-batch.entity';

/**
 * "An issue shipped and its members' digest is due." Emitted by the magazine
 * module, consumed by `NewsletterDigestService`, which turns it into a durable
 * per-subscriber ledger and drains it on a cron.
 *
 * A domain event rather than a direct call: the magazine module owns issues and
 * this module owns the subscriber list and the mail transport, and neither
 * needs to import the other to say "this mailing is due". The listener is
 * awaited (`emitAsync`) so the publisher can tell whether the mailing was
 * durably queued before it stamps the issue as sent.
 */
export const NEWSLETTER_DIGEST_DUE = 'newsletter.digest_due';

export interface NewsletterDigestDueEvent {
  /** The magazine issue this mailing belongs to. One mailing per issue, ever. */
  issueId: string;
  issueNumber: string;
  issueTitle: string;
  /** Already resolved to display text by the publisher. */
  items: NewsletterDigestItem[];
}

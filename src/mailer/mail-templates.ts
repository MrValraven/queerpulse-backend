/**
 * Keyed transactional email templates. Each key maps to a typed params shape and
 * renders to `{ subject, text, html }`. Centralising templates here (rather than
 * building subject/body strings at each call site) keeps every transactional
 * email consistent and makes the mailer's `send()` fully type-checked: a caller
 * cannot pass the wrong params for a template, and adding a key without a case
 * is a compile error.
 */

export type MailTemplateKey =
  | 'listing_draft_resume_link'
  | 'newsletter_confirm'
  | 'ops_inquiry_received'
  | 'concern_update';

/** The params each template key requires. */
export interface MailTemplateParams {
  listing_draft_resume_link: { resumeUrl: string };
  newsletter_confirm: { confirmUrl: string };
  ops_inquiry_received: {
    /** 'contact' | 'partner' — which marketing form it came from. */
    kind: string;
    senderName: string;
    senderEmail: string;
    /** Topic/interest selector, when the form supplied one. */
    subject?: string;
    /** Organisation name (partner form only). */
    orgName?: string;
    body: string;
  };
  /** Sent to a LOGGED-OUT submitter when their governance concern reaches a
   *  terminal outcome (a signed-in member gets an in-app notification instead). */
  concern_update: {
    status: 'resolved' | 'dismissed';
  };
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Template keys that are BULK mail — sent to a subscriber list rather than to
 * one person about something they just did.
 *
 * EMPTY, and that is the product decision rather than an oversight: QueerPulse
 * delivers no bulk mail to members. The one entry this set ever held was the
 * members' digest, whose whole send path (the newsletter module's queue, its
 * once-a-minute drain, and the `digest`/`digest_test` templates) has been
 * deleted in favour of an in-app issue panel plus one notification per member.
 * Every remaining key above is transactional: one message, to one person,
 * about something they just did.
 *
 * The machinery below stays wired up because it is the guarantee, not the
 * feature: if a bulk template is ever added to this set, `MailerService.send`
 * refuses to dispatch it without a resolvable per-recipient unsubscribe link
 * and attaches `List-Unsubscribe` / `List-Unsubscribe-Post` headers plus an
 * in-body opt-out. Bulk email with no self-serve opt-out breaches CAN-SPAM,
 * GDPR Art. 21 / ePrivacy and CASL, and burns the sending domain's reputation
 * under the 2024 Gmail/Yahoo bulk-sender rules.
 */
export const BULK_TEMPLATE_KEYS: ReadonlySet<MailTemplateKey> = new Set();

/**
 * Appends the human-facing opt-out to a rendered bulk message, in BOTH the
 * plain-text and HTML parts. The `List-Unsubscribe` header covers mail clients
 * that surface a native button; this covers everyone else, who otherwise has no
 * way to discover the unsubscribe URL at all.
 */
export function withUnsubscribeFooter(
  mail: RenderedMail,
  unsubscribeUrl: string,
): RenderedMail {
  return {
    subject: mail.subject,
    text: `${mail.text}\n\n--\nYou are receiving this because you subscribed to the QueerPulse newsletter.\nUnsubscribe: ${unsubscribeUrl}`,
    html:
      `${mail.html}<hr/><p style="font-size:12px;color:#666">` +
      `You are receiving this because you subscribed to the QueerPulse newsletter. ` +
      `<a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a>.</p>`,
  };
}

/** Minimal HTML-escape for values interpolated into the `html` body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderTemplate<K extends MailTemplateKey>(
  key: K,
  params: MailTemplateParams[K],
): RenderedMail {
  switch (key) {
    case 'listing_draft_resume_link': {
      const { resumeUrl } =
        params as MailTemplateParams['listing_draft_resume_link'];
      const safeUrl = escapeHtml(resumeUrl);
      return {
        subject: 'Pick up your business listing where you left off',
        text:
          `Here's your link to keep going on your business listing:\n\n` +
          `${resumeUrl}\n\n` +
          `It opens the draft on any device. If you didn't ask for this, you ` +
          `can safely ignore this email.`,
        html:
          `<p>Here's your link to keep going on your business listing:</p>` +
          `<p><a href="${safeUrl}">${safeUrl}</a></p>` +
          `<p>It opens the draft on any device. If you didn't ask for this, ` +
          `you can safely ignore this email.</p>`,
      };
    }
    case 'newsletter_confirm': {
      const { confirmUrl } = params as MailTemplateParams['newsletter_confirm'];
      const safeUrl = escapeHtml(confirmUrl);
      return {
        subject: 'Confirm your QueerPulse newsletter subscription',
        text:
          `Thanks for signing up for the QueerPulse newsletter.\n\n` +
          `Please confirm your subscription by opening this link:\n\n` +
          `${confirmUrl}\n\n` +
          `If you didn't ask to subscribe, you can safely ignore this email — ` +
          `nothing will be sent until you confirm.`,
        html:
          `<p>Thanks for signing up for the QueerPulse newsletter.</p>` +
          `<p>Please confirm your subscription:</p>` +
          `<p><a href="${safeUrl}">Confirm my subscription</a></p>` +
          `<p>If you didn't ask to subscribe, you can safely ignore this ` +
          `email — nothing will be sent until you confirm.</p>`,
      };
    }
    case 'ops_inquiry_received': {
      const { kind, senderName, senderEmail, subject, orgName, body } =
        params as MailTemplateParams['ops_inquiry_received'];
      const label = kind === 'partner' ? 'Partnership inquiry' : 'Contact form';
      const lines = [
        `From: ${senderName} <${senderEmail}>`,
        orgName ? `Organisation: ${orgName}` : null,
        subject ? `Topic: ${subject}` : null,
        '',
        body,
      ].filter((line): line is string => line !== null);
      return {
        subject: `[${label}] New message from ${senderName}`,
        text:
          `A new ${label.toLowerCase()} message has come in:\n\n` +
          `${lines.join('\n')}\n`,
        html:
          `<p>A new ${escapeHtml(label.toLowerCase())} message has come in:</p>` +
          `<p><b>From:</b> ${escapeHtml(senderName)} ` +
          `&lt;${escapeHtml(senderEmail)}&gt;</p>` +
          (orgName
            ? `<p><b>Organisation:</b> ${escapeHtml(orgName)}</p>`
            : '') +
          (subject ? `<p><b>Topic:</b> ${escapeHtml(subject)}</p>` : '') +
          `<p style="white-space:pre-wrap">${escapeHtml(body)}</p>`,
      };
    }
    case 'concern_update': {
      const { status } = params as MailTemplateParams['concern_update'];
      const outcome =
        status === 'resolved'
          ? "We've looked into it and marked it resolved."
          : "We've reviewed it and closed it without further action.";
      return {
        subject: 'An update on the concern you raised',
        // The copy used to invite a reply, but this mail goes out from the
        // no-reply sender (`MailerService`'s default `from`) and `send` sets
        // no `replyTo`, so anyone who followed that instruction wrote into a
        // void. For a safety concern that is the worst possible place to lose
        // someone, hence the one live route stays named instead.
        text:
          `Thanks for raising a concern with QueerPulse.\n\n` +
          `${outcome}\n\n` +
          `This address is unattended, so replies here won't reach us. If you ` +
          `have more to add, submit another concern from the governance page. ` +
          `Thank you for helping keep the community safe.`,
        html:
          `<p>Thanks for raising a concern with QueerPulse.</p>` +
          `<p>${escapeHtml(outcome)}</p>` +
          `<p>This address is unattended, so replies here won't reach us. If ` +
          `you have more to add, submit another concern from the governance ` +
          `page. Thank you for helping keep the community safe.</p>`,
      };
    }
    default: {
      // Exhaustiveness guard: a new MailTemplateKey without a case above is a
      // compile-time error here.
      const exhaustive: never = key;
      throw new Error(`Unknown mail template: ${String(exhaustive)}`);
    }
  }
}

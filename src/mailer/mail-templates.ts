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
        text:
          `Thanks for raising a concern with QueerPulse.\n\n` +
          `${outcome}\n\n` +
          `If you have more to add, you can reply to this email or submit ` +
          `another concern from the governance page. Thank you for helping ` +
          `keep the community safe.`,
        html:
          `<p>Thanks for raising a concern with QueerPulse.</p>` +
          `<p>${escapeHtml(outcome)}</p>` +
          `<p>If you have more to add, you can reply to this email or submit ` +
          `another concern from the governance page. Thank you for helping ` +
          `keep the community safe.</p>`,
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

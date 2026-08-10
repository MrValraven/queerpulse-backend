import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import {
  MailTemplateKey,
  MailTemplateParams,
  renderTemplate,
} from './mail-templates';

// Outbound-call budget for the SMTP transport, matching the rest of the
// codebase's server-initiated network calls (geocode uses 5000ms, web push
// uses 10000ms): nodemailer's own defaults are 2 minutes to connect and 10
// minutes per socket operation, which is long enough that a slow/unreachable
// SMTP host would tie up a request handler (newsletter/inquiries/listing-draft
// sends all await `MailerService.send()` inline) for minutes instead of
// failing fast.
const SMTP_CONNECTION_TIMEOUT_MS = 8000;
const SMTP_SOCKET_TIMEOUT_MS = 8000;

/**
 * The one transactional mailer for the platform. Transport is pluggable and
 * env-gated:
 *  - `SMTP_URL` set → a real SMTP transport from that connection string.
 *  - else `SMTP_HOST` set → a real SMTP transport from the discrete host/port/
 *    auth fields.
 *  - else → a log-only transport (nodemailer's `jsonTransport`, which builds the
 *    full message but sends NOTHING over the network). Dev/test default; the
 *    message body is logged so links are visible without a mail provider.
 *
 * `send()` is keyed on {@link MailTemplateKey}, so every email goes through a
 * typed, centrally-defined template ({@link renderTemplate}) rather than an
 * ad-hoc string at the call site.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: Transporter;
  private readonly from: string;
  /** True when a real SMTP transport is configured; false = log-only fallback. */
  private readonly deliveringForReal: boolean;

  constructor(private readonly config: ConfigService) {
    this.from =
      this.config.get<string>('mail.from') ??
      'QueerPulse <no-reply@queerpulse.example>';

    const smtpUrl = this.config.get<string>('mail.smtpUrl');
    const host = this.config.get<string>('mail.host');

    if (smtpUrl) {
      this.transporter = createTransport(this.withTimeouts(smtpUrl));
      this.deliveringForReal = true;
    } else if (host) {
      this.transporter = createTransport({
        host,
        port: this.config.get<number>('mail.port') ?? 587,
        secure: this.config.get<boolean>('mail.secure') ?? false,
        auth: this.smtpAuth(),
        connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
        socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      });
      this.deliveringForReal = true;
    } else {
      // Log-only: builds the message, sends nothing. Not an error — it is the
      // expected dev/test state — but warned once so it's never mistaken for
      // real delivery in a deployed environment.
      this.transporter = createTransport({ jsonTransport: true });
      this.deliveringForReal = false;
      this.logger.warn(
        'No SMTP configured (SMTP_URL / SMTP_HOST unset): MailerService is ' +
          'log-only. Emails are built and logged but NOT delivered.',
      );
    }
  }

  private smtpAuth(): { user: string; pass: string } | undefined {
    const user = this.config.get<string>('mail.user');
    const pass = this.config.get<string>('mail.password');
    return user && pass ? { user, pass } : undefined;
  }

  /**
   * Appends `connectionTimeout`/`socketTimeout` as query params to an SMTP
   * connection string. Nodemailer's `createTransport(url)` branch parses the
   * whole options object from the URL itself (`shared.parseConnectionUrl`),
   * so a second positional options argument would be silently discarded —
   * the timeouts have to travel as query params on the URL to take effect.
   * A value already present in `smtpUrl` (an operator override) is left
   * alone rather than clobbered.
   */
  private withTimeouts(smtpUrl: string): string {
    const url = new URL(smtpUrl);
    if (!url.searchParams.has('connectionTimeout')) {
      url.searchParams.set(
        'connectionTimeout',
        String(SMTP_CONNECTION_TIMEOUT_MS),
      );
    }
    if (!url.searchParams.has('socketTimeout')) {
      url.searchParams.set('socketTimeout', String(SMTP_SOCKET_TIMEOUT_MS));
    }
    return url.toString();
  }

  /**
   * Render {@link templateKey} with its typed params and dispatch it to `to`.
   * Throws if a configured SMTP transport fails to send (so a genuine delivery
   * failure surfaces rather than being swallowed as a false success); the
   * log-only transport never throws.
   */
  async send<K extends MailTemplateKey>(
    to: string,
    templateKey: K,
    params: MailTemplateParams[K],
  ): Promise<void> {
    const { subject, text, html } = renderTemplate(templateKey, params);
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to,
        subject,
        text,
        html,
      });
      if (this.deliveringForReal) {
        this.logger.log(
          `Sent "${templateKey}" email to ${to} (messageId ${info.messageId ?? 'n/a'})`,
        );
      } else {
        this.logger.log(
          `[log-only] "${templateKey}" email to ${to} (not delivered): ${text}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to send "${templateKey}" email to ${to}: ${String(error)}`,
      );
      throw error;
    }
  }
}

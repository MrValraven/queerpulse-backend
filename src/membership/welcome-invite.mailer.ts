import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateEmailResponse, Resend } from 'resend';
import {
  isRetryable,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  retryDelayMs,
  SEND_ATTEMPT_TIMEOUT_MS,
  sleep,
} from '../auth/email-code/email-code.mailer';
import { DEFAULT_RESEND_FROM } from '../config/email.config';
import type { WelcomeInviteLocale } from './dto/send-welcome-invite-email.dto';

/** The three variables the published welcome templates take, all strings. */
export interface WelcomeInviteVariables {
  /** Already HTML-escaped: the template prints it unescaped. */
  name: string;
  inviteLink: string;
  expiresOn: string;
}

export interface WelcomeInviteEmail {
  to: string;
  locale: WelcomeInviteLocale;
  variables: WelcomeInviteVariables;
  /** Used only in log lines. */
  joinRequestId: string;
  /** Keeps a double click from sending twice. */
  idempotencyKey: string;
}

export type WelcomeInviteSendResult =
  | { delivered: true; emailId: string | null }
  | {
      delivered: false;
      failure: 'resend_rejected' | 'resend_unavailable' | 'not_configured';
    };

/**
 * Sends the welcome email with the invite link through a published Resend
 * template, only when a reviewer asks for it.
 *
 * It follows the sign-in mailer: the Resend SDK answers `{ data, error,
 * headers }` and does not throw, only network errors, 429 and 5xx get a
 * bounded retry, and every attempt carries the same idempotency key. Log
 * lines carry only the join request id, the Resend error name, its status
 * code, the attempt count and the Resend email id: the address, the name, the
 * invite link and Resend's free-text error message stay out of every line.
 */
@Injectable()
export class WelcomeInviteMailer {
  private readonly logger = new Logger(WelcomeInviteMailer.name);
  private readonly resend: Resend | null;
  private readonly from: string;
  private readonly templateIdEn: string | undefined;
  private readonly templateIdPt: string | undefined;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('email.resendApiKey');
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.from = config.get<string>('email.from') || DEFAULT_RESEND_FROM;
    this.templateIdEn = config.get<string>('email.welcomeTemplateIdEn');
    this.templateIdPt = config.get<string>('email.welcomeTemplateIdPt');
  }

  /** True when the API key and this language's template id are both set. */
  isConfiguredFor(locale: WelcomeInviteLocale): boolean {
    return this.resend !== null && Boolean(this.templateIdFor(locale));
  }

  async sendWelcomeInvite(
    email: WelcomeInviteEmail,
  ): Promise<WelcomeInviteSendResult> {
    const { joinRequestId } = email;
    const templateId = this.templateIdFor(email.locale);

    if (!this.resend || !templateId) {
      const missing = !this.resend
        ? 'RESEND_API_KEY'
        : email.locale === 'pt'
          ? 'RESEND_WELCOME_TEMPLATE_ID_PT'
          : 'RESEND_WELCOME_TEMPLATE_ID_EN';
      this.logger.error(
        `Welcome email not sent: ${missing} is unset. joinRequestId=${joinRequestId}`,
      );
      return { delivered: false, failure: 'not_configured' };
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await this.sendOnce(this.resend, email, templateId);

      if (!response.error) {
        const emailId = response.data?.id ?? null;
        this.logger.log(
          `Welcome email accepted by Resend: emailId=${emailId} joinRequestId=${joinRequestId}`,
        );
        return { delivered: true, emailId };
      }

      const statusCode = response.error.statusCode ?? null;
      const details = `name=${response.error.name} status=${statusCode ?? 'none'} joinRequestId=${joinRequestId}`;

      if (!isRetryable(statusCode)) {
        this.logger.error(
          `Resend refused the welcome email: ${details} attempts=${attempt}`,
        );
        return { delivered: false, failure: 'resend_rejected' };
      }

      if (attempt === MAX_ATTEMPTS) {
        this.logger.error(
          `Resend stayed unavailable for the welcome email: ${details} attempts=${attempt}`,
        );
        return { delivered: false, failure: 'resend_unavailable' };
      }

      const delayMs = retryDelayMs(response.headers, attempt - 1);
      if (delayMs > MAX_RETRY_AFTER_MS) {
        this.logger.error(
          `Resend asked for a wait too long to retry the welcome email: ${details} attempts=${attempt} retryAfterMs=${delayMs}`,
        );
        return { delivered: false, failure: 'resend_unavailable' };
      }

      this.logger.warn(
        `Resend could not take the welcome email yet, retrying: ${details} attempt=${attempt}/${MAX_ATTEMPTS} delayMs=${delayMs}`,
      );
      await sleep(delayMs);
    }

    // The loop always returns on its last attempt; this satisfies the compiler.
    return { delivered: false, failure: 'resend_unavailable' };
  }

  private templateIdFor(locale: WelcomeInviteLocale): string | undefined {
    return locale === 'pt' ? this.templateIdPt : this.templateIdEn;
  }

  private async sendOnce(
    resend: Resend,
    email: WelcomeInviteEmail,
    templateId: string,
  ): Promise<CreateEmailResponse> {
    try {
      return await resend.emails.send(
        {
          from: this.from,
          to: email.to,
          template: {
            id: templateId,
            variables: { ...email.variables },
          },
        },
        {
          idempotencyKey: email.idempotencyKey,
          signal: AbortSignal.timeout(SEND_ATTEMPT_TIMEOUT_MS),
        },
      );
    } catch {
      // A timeout, an abort or anything else thrown counts as a network error
      // so it gets the same retry, and its message (which could quote the
      // payload) is never logged.
      return {
        data: null,
        error: { statusCode: null, name: 'application_error', message: '' },
        headers: null,
      };
    }
  }
}

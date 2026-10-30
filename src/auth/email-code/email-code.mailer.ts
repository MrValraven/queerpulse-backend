import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateEmailResponse, Resend } from 'resend';
import { DEFAULT_RESEND_FROM } from '../../config/email.config';

export type EmailCodeLocale = 'en' | 'pt';

export interface SignInCodeEmail {
  to: string;
  code: string;
  minutes: number;
  locale: EmailCodeLocale;
  /** `true` sends the create-your-account template, falling back to the sign-in one when unset. */
  isRegistration?: boolean;
  challengeId: string;
}

export type SignInCodeSendResult =
  | { delivered: true; emailId: string | null }
  | {
      delivered: false;
      failure: 'resend_rejected' | 'resend_unavailable' | 'not_configured';
    };

/** Three tries in all: the first send plus two retries. */
export const MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3 when Resend sends no `retry-after`. */
export const DEFAULT_RETRY_DELAYS_MS = [300, 900];
/** A longer `retry-after` would hold the request open too long, so the send ends. */
export const MAX_RETRY_AFTER_MS = 1500;
/**
 * Worst case per send stays within the frontend's 15 s request timeout:
 * 3 x 4 s + 0.3 s + 0.9 s = 13.2 s with the default backoff, and
 * 3 x 4 s + 1.5 s + 1.5 s = 15 s with an honoured `retry-after`.
 */
export const SEND_ATTEMPT_TIMEOUT_MS = 4000;

/**
 * Sends the 6-digit sign-in code through a published Resend template.
 *
 * The Resend SDK answers `{ data, error, headers }` and does not throw. Each
 * challenge sends under its own idempotency key, so a retry after a lost
 * response can never deliver the same code twice. Log lines carry only the
 * Resend error name, its status code, the challenge id, the attempt count and
 * the Resend email id: the address, the code and Resend's free-text error
 * message stay out of every log line.
 */
@Injectable()
export class EmailCodeMailer {
  private readonly logger = new Logger(EmailCodeMailer.name);
  private readonly resend: Resend | null;
  private readonly isDevLog: boolean;
  private readonly from: string;
  private readonly templateIdEn: string | undefined;
  private readonly templateIdPt: string | undefined;
  private readonly signUpTemplateIdEn: string | undefined;
  private readonly signUpTemplateIdPt: string | undefined;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('email.resendApiKey');
    this.resend = apiKey ? new Resend(apiKey) : null;
    // `email.devLog` is already false in production; the second check keeps
    // the code out of production logs even if the config were built wrong.
    this.isDevLog =
      config.get<boolean>('email.devLog') === true &&
      config.get<string>('app.nodeEnv') !== 'production';
    this.from = config.get<string>('email.from') || DEFAULT_RESEND_FROM;
    this.templateIdEn = config.get<string>('email.signInTemplateIdEn');
    this.templateIdPt = config.get<string>('email.signInTemplateIdPt');
    this.signUpTemplateIdEn = config.get<string>('email.signUpTemplateIdEn');
    this.signUpTemplateIdPt = config.get<string>('email.signUpTemplateIdPt');
  }

  async sendSignInCode(email: SignInCodeEmail): Promise<SignInCodeSendResult> {
    const { challengeId } = email;

    if (!this.resend) {
      if (!this.isDevLog) {
        this.logger.error(
          `Sign-in code email not sent: RESEND_API_KEY is unset and EMAIL_CODE_DEV_LOG is off. challengeId=${challengeId}`,
        );
        return { delivered: false, failure: 'not_configured' };
      }
      // The one log line allowed to carry a code: EMAIL_CODE_DEV_LOG=true
      // outside production only.
      this.logger.log(
        `[dev] sign-in code for challenge ${challengeId}: ${email.code}`,
      );
      return { delivered: true, emailId: null };
    }

    const isPortuguese = email.locale === 'pt';
    const signUpTemplateId = isPortuguese
      ? this.signUpTemplateIdPt
      : this.signUpTemplateIdEn;
    const templateId =
      (email.isRegistration ? signUpTemplateId : undefined) ||
      (isPortuguese ? this.templateIdPt : this.templateIdEn);
    if (!templateId) {
      const variable =
        email.locale === 'pt'
          ? 'RESEND_SIGNIN_TEMPLATE_ID_PT'
          : 'RESEND_SIGNIN_TEMPLATE_ID_EN';
      this.logger.error(
        `Sign-in code email not sent: ${variable} is unset. challengeId=${challengeId}`,
      );
      return { delivered: false, failure: 'not_configured' };
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await this.sendOnce(this.resend, email, templateId);

      if (!response.error) {
        const emailId = response.data?.id ?? null;
        this.logger.log(
          `Sign-in code email accepted by Resend: emailId=${emailId} challengeId=${challengeId}`,
        );
        return { delivered: true, emailId };
      }

      const statusCode = response.error.statusCode ?? null;
      const details = `name=${response.error.name} status=${statusCode ?? 'none'} challengeId=${challengeId}`;

      if (!isRetryable(statusCode)) {
        this.logger.error(
          `Resend refused the sign-in code email: ${details} attempts=${attempt}`,
        );
        return { delivered: false, failure: 'resend_rejected' };
      }

      if (attempt === MAX_ATTEMPTS) {
        this.logger.error(
          `Resend stayed unavailable for the sign-in code email: ${details} attempts=${attempt}`,
        );
        return { delivered: false, failure: 'resend_unavailable' };
      }

      const delayMs = retryDelayMs(response.headers, attempt - 1);
      if (delayMs > MAX_RETRY_AFTER_MS) {
        this.logger.error(
          `Resend asked for a wait too long to retry the sign-in code email: ${details} attempts=${attempt} retryAfterMs=${delayMs}`,
        );
        return { delivered: false, failure: 'resend_unavailable' };
      }

      this.logger.warn(
        `Resend could not take the sign-in code email yet, retrying: ${details} attempt=${attempt}/${MAX_ATTEMPTS} delayMs=${delayMs}`,
      );
      await sleep(delayMs);
    }

    // The loop always returns on its last attempt; this satisfies the compiler.
    return { delivered: false, failure: 'resend_unavailable' };
  }

  private async sendOnce(
    resend: Resend,
    email: SignInCodeEmail,
    templateId: string,
  ): Promise<CreateEmailResponse> {
    try {
      return await resend.emails.send(
        {
          from: this.from,
          to: email.to,
          template: {
            id: templateId,
            variables: { code: email.code, minutes: email.minutes },
          },
        },
        {
          idempotencyKey: `sign-in-code/${email.challengeId}`,
          signal: AbortSignal.timeout(SEND_ATTEMPT_TIMEOUT_MS),
        },
      );
    } catch {
      // The SDK turns fetch failures into `{ error }` and rethrows only when
      // the attempt's timeout signal fires mid-response. A timeout, an abort
      // or anything else thrown counts as a network error so it gets the same
      // retry, and its message (which could quote the payload) is never logged.
      return {
        data: null,
        error: { statusCode: null, name: 'application_error', message: '' },
        headers: null,
      };
    }
  }
}

/** Network errors (no status), rate limits and server errors get a retry. */
export function isRetryable(statusCode: number | null): boolean {
  return statusCode === null || statusCode === 429 || statusCode >= 500;
}

/**
 * Milliseconds to wait before the next attempt: Resend's `retry-after`
 * seconds when the header holds a number, else the default backoff step.
 * The SDK lowercases every response header name.
 */
export function retryDelayMs(
  headers: Record<string, string> | null,
  retryIndex: number,
): number {
  const retryAfter = headers?.['retry-after']?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  return DEFAULT_RETRY_DELAYS_MS[retryIndex] ?? 900;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

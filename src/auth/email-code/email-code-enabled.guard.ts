import { CanActivate, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailCodeRefusedError } from './email-code-refusal';

/**
 * Refuses every email code route with 503 `email_code_unavailable` while the
 * feature is switched off (`email.enabled` in `email.config.ts`: no Resend
 * key and templates, and no local `EMAIL_CODE_DEV_LOG`).
 *
 * Applied at class level on `EmailCodeController`, so it runs ahead of the
 * per-route throttler guards and the validation pipe: a refused request sets
 * no cookie, counts against no email code bucket and touches no table.
 */
@Injectable()
export class EmailCodeEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (this.config.get<boolean>('email.enabled') !== true) {
      throw new EmailCodeRefusedError('email_code_unavailable');
    }
    return true;
  }
}

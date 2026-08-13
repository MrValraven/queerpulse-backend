import { Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PhoneVerificationProvider } from './phone-verification.provider';

interface PendingChallenge {
  code: string;
  phoneNumber: string;
  expiresAt: number;
}

const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Development phone-verification provider. It does NOT send an SMS — it LOGS the
 * six-digit code so a developer can complete the flow locally, and holds the
 * outstanding challenge in memory (single-instance, dev-only; it intentionally
 * does not survive a restart).
 *
 * This is the swap point for a real vendor: replace this class in
 * `VerificationModule`'s provider binding with a Twilio-Verify-backed one and
 * nothing else in the feature changes. Never ship this to production.
 */
@Injectable()
export class DevPhoneVerificationProvider implements PhoneVerificationProvider {
  private readonly logger = new Logger('PhoneVerification');
  private readonly pending = new Map<string, PendingChallenge>();

  startChallenge(userId: string, phoneNumber: string): Promise<void> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pending.set(userId, {
      code,
      phoneNumber,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    // DEV ONLY: a real provider delivers this over SMS and never logs it.
    this.logger.log(`Verification code for ${phoneNumber}: ${code}`);
    return Promise.resolve();
  }

  checkChallenge(userId: string, code: string): Promise<boolean> {
    const challenge = this.pending.get(userId);
    if (!challenge) return Promise.resolve(false);
    if (Date.now() > challenge.expiresAt) {
      this.pending.delete(userId);
      return Promise.resolve(false);
    }
    const matches = challenge.code === code.trim();
    if (matches) this.pending.delete(userId);
    return Promise.resolve(matches);
  }
}

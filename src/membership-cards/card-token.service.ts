import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from 'node:crypto';

/**
 * How long a minted card token stays valid. Short on purpose: this is the
 * single defence against a member screenshotting their card and sending the
 * image to someone else. The frontend re-mints on a timer while the card is
 * on screen.
 */
export const CARD_TOKEN_TTL_SECONDS = 60;

interface CardTokenPayload {
  /** card id */
  c: string;
  /** expiry, epoch seconds */
  e: number;
}

/**
 * Mints and verifies the short-lived proof-of-membership token encoded in a
 * card's QR. Ed25519 over a compact `base64url(payload).base64url(signature)`
 * envelope: small enough to keep the QR at a low error-correction density,
 * and verifiable without a database read.
 *
 * Verification never throws. Every failure path (malformed, tampered, wrong
 * key, expired) returns null, so a caller cannot distinguish them and an
 * attacker learns nothing from the shape of the rejection.
 */
@Injectable()
export class CardTokenService implements OnModuleInit {
  private readonly logger = new Logger(CardTokenService.name);
  private privateKey: KeyObject | null = null;
  private publicKey: KeyObject | null = null;

  constructor(private readonly config: ConfigService) {
    this.loadKeys();
  }

  onModuleInit(): void {
    if (!this.privateKey || !this.publicKey) {
      this.logger.warn(
        'Card signing keys are not configured. Membership card tokens are disabled.',
      );
    }
  }

  private loadKeys(): void {
    const privatePem = this.config.get<string>('CARD_SIGNING_PRIVATE_KEY');
    const publicPem = this.config.get<string>('CARD_SIGNING_PUBLIC_KEY');
    if (!privatePem || !publicPem) return;
    try {
      this.privateKey = createPrivateKey(privatePem);
      this.publicKey = createPublicKey(publicPem);
    } catch {
      this.privateKey = null;
      this.publicKey = null;
    }
  }

  mint(cardId: string): { token: string; expiresAt: string } {
    if (!this.privateKey) {
      throw new Error('Card signing key is not configured');
    }
    const expiresAtSeconds =
      Math.floor(Date.now() / 1000) + CARD_TOKEN_TTL_SECONDS;
    const payload: CardTokenPayload = { c: cardId, e: expiresAtSeconds };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = sign(
      null,
      Buffer.from(encoded),
      this.privateKey,
    ).toString('base64url');
    return {
      token: `${encoded}.${signature}`,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    };
  }

  verify(token: string): string | null {
    if (typeof token !== 'string') return null;
    if (!this.publicKey) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [encoded, signature] = parts as [string, string];
    if (!encoded || !signature) return null;

    try {
      const signatureBytes = Buffer.from(signature, 'base64url');
      // Ed25519 signatures are always 64 bytes. Reject anything else before
      // handing it to `verify`.
      if (signatureBytes.length !== 64) return null;
      const isSigned = verify(
        null,
        Buffer.from(encoded),
        this.publicKey,
        signatureBytes,
      );
      if (!isSigned) return null;

      const payload = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as Partial<CardTokenPayload>;
      if (typeof payload.c !== 'string' || typeof payload.e !== 'number') {
        return null;
      }
      if (payload.e * 1000 <= Date.now()) return null;
      return payload.c;
    } catch {
      return null;
    }
  }
}

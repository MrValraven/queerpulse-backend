import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from 'node:crypto';

/** 16 raw UUID bytes, then a big-endian uint16 code version. */
const CARD_ID_BYTES = 16;
const CODE_VERSION_BYTES = 2;
const PAYLOAD_BYTES = CARD_ID_BYTES + CODE_VERSION_BYTES;

/** Ed25519 signatures are always exactly this long. */
const SIGNATURE_BYTES = 64;

/** The largest code version a two-byte field can carry. */
export const MAX_CODE_VERSION = 0xffff;

export interface CardTokenPayload {
  cardId: string;
  codeVersion: number;
}

function toUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Mints and verifies the permanent proof-of-membership code encoded in a
 * card's QR. Ed25519 over a compact `base64url(payload).base64url(signature)`
 * envelope, verifiable without a database read.
 *
 * The code carries no clock. It is a stable reference to a card rather than a
 * short-lived assertion about who is holding the phone, which is what lets the
 * same code be printed on a physical card and drawn on a screen. Whether the
 * card behind it is still good is answered on every scan by the live lookup in
 * `CardVerificationService`, so revocation remains instant.
 *
 * The payload is binary purely for QR density. Measured at error correction M,
 * the JSON form this replaced produced a 53-module symbol and this one produces
 * 45, which on an 85.6mm printed card is the difference between a cramped
 * symbol and a comfortable one.
 *
 * Verification never throws. Every failure path (malformed, tampered, wrong
 * key, wrong length) returns null, so a caller cannot distinguish them and an
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
        'Card signing keys are not configured. Membership card codes are disabled.',
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

  /**
   * Whether this platform can produce codes at all. Callers building a card
   * DTO check this rather than catching: a missing signing key should cost a
   * member the code on their card, never their whole wallet page.
   */
  get isConfigured(): boolean {
    return Boolean(this.privateKey && this.publicKey);
  }

  /**
   * The card's permanent code. Deterministic: one card at one code version
   * always produces one string.
   */
  mint(cardId: string, codeVersion: number): string {
    if (!this.privateKey) {
      throw new Error('Card signing key is not configured');
    }
    const hex = cardId.replace(/-/g, '');
    // Guarded rather than trusted: `Buffer.from(x, 'hex')` truncates silently
    // on bad input, which would mint a valid signature over the wrong card.
    if (!/^[0-9a-f]{32}$/i.test(hex)) {
      throw new Error('Card id is not a UUID');
    }
    if (
      !Number.isInteger(codeVersion) ||
      codeVersion < 1 ||
      codeVersion > MAX_CODE_VERSION
    ) {
      throw new Error('Code version is out of range');
    }
    const payload = Buffer.alloc(PAYLOAD_BYTES);
    Buffer.from(hex, 'hex').copy(payload, 0);
    payload.writeUInt16BE(codeVersion, CARD_ID_BYTES);
    const encoded = payload.toString('base64url');
    const signature = sign(
      null,
      Buffer.from(encoded),
      this.privateKey,
    ).toString('base64url');
    return `${encoded}.${signature}`;
  }

  verify(token: string): CardTokenPayload | null {
    if (typeof token !== 'string') return null;
    if (!this.publicKey) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [encoded, signature] = parts as [string, string];
    if (!encoded || !signature) return null;

    try {
      const signatureBytes = Buffer.from(signature, 'base64url');
      if (signatureBytes.length !== SIGNATURE_BYTES) return null;
      const isSigned = verify(
        null,
        Buffer.from(encoded),
        this.publicKey,
        signatureBytes,
      );
      if (!isSigned) return null;

      const payload = Buffer.from(encoded, 'base64url');
      if (payload.length !== PAYLOAD_BYTES) return null;
      return {
        cardId: toUuid(payload.subarray(0, CARD_ID_BYTES)),
        codeVersion: payload.readUInt16BE(CARD_ID_BYTES),
      };
    } catch {
      return null;
    }
  }
}

import { createHmac, randomBytes } from 'crypto';

/** Domain separation: the server secret may be shared with token signing,
 *  so this purpose derives its own key from it and uses that key alone. */
const EMAIL_CODE_KEY_PURPOSE = 'queerpulse:email-sign-in-code:v1';

/** The random stand-in secret a test process uses, made once so every code
 *  minted in that process verifies against the same key. */
let testProcessSecret: string | null = null;

/**
 * The HMAC key that sign-in codes are hashed with. `EMAIL_CODE_SECRET` wins
 * when set, which decouples stored codes from JWT rotation; otherwise the key
 * is derived from `JWT_ACCESS_SECRET`. Either way the raw secret is never the
 * key itself. A process with neither secret refuses to issue codes, except
 * under `NODE_ENV=test`, where a random per-process value stands in.
 * (Mirrors `src/messaging/matched-member-key.ts`.)
 */
export function deriveEmailCodeKey(
  codeSecret: string | undefined,
  jwtAccessSecret: string | undefined,
  nodeEnv: string | undefined,
): Buffer {
  let serverSecret = codeSecret || jwtAccessSecret;
  if (!serverSecret) {
    if (nodeEnv !== 'test') {
      throw new Error(
        'EMAIL_CODE_SECRET or JWT_ACCESS_SECRET must be set to issue sign-in codes',
      );
    }
    testProcessSecret ??= randomBytes(32).toString('hex');
    serverSecret = testProcessSecret;
  }
  return createHmac('sha256', serverSecret)
    .update(EMAIL_CODE_KEY_PURPOSE)
    .digest();
}

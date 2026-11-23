import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import {
  createHash,
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { UsersService } from '../../users/users.service';
import {
  isDeliverableEmailAddress,
  normalizeEmailAddress,
} from './email-code-address';
import {
  EmailCodeReason,
  EmailCodeRefusalExtras,
  EmailCodeRefusedError,
} from './email-code-refusal';
import {
  deriveEmailCodeKey,
  deriveEmailCodeTrustedRequesterKey,
} from './email-code-secret';
import {
  isTrustedRequesterToken,
  mintTrustedRequesterToken,
} from './email-code-trusted-requester';
import {
  EMAIL_CODE_ADDRESS_SEND_LIMIT,
  EMAIL_CODE_ADDRESS_WINDOW_MS,
  EMAIL_CODE_JOIN_REQUEST_ADDRESS_SEND_LIMIT,
  EMAIL_CODE_JOIN_REQUEST_TRUSTED_ADDRESS_SEND_LIMIT,
  EMAIL_CODE_MAX_WRONG_ATTEMPTS,
  EMAIL_CODE_REQUESTER_WINDOW_LIMIT,
  EMAIL_CODE_REQUESTER_WINDOW_MS,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
  EMAIL_CODE_TRUSTED_ADDRESS_SEND_LIMIT,
  EMAIL_CODE_TTL_MINUTES,
  EMAIL_CODE_TTL_MS,
  EMAIL_CODE_UNKNOWN_CHALLENGE_ATTEMPTS_LEFT,
} from './email-code.constants';
import {
  EmailCodeLocale,
  EmailCodeMailer,
  SignInCodeSendResult,
} from './email-code.mailer';
import {
  EmailSignInChallenge,
  EmailSignInChallengePurpose,
} from './email-sign-in-challenge.entity';

export interface IssuedEmailCode {
  challengeId: string;
  expiresAt: Date;
  resendAvailableAt: Date;
}

export interface VerifiedEmailCode {
  email: string;
  userId: string | null;
}

interface IssueInput {
  purpose: EmailSignInChallengePurpose;
  email: string;
  userId: string | null;
  requesterKey: string;
  locale: EmailCodeLocale;
  /** Picks the create-your-account email template over the sign-in one. */
  isRegistration?: boolean;
  shouldDeliver: boolean;
  /** The browser holds a valid trusted-requester cookie for this address. */
  isTrustedRequester: boolean;
}

type VerifyOutcome =
  | { kind: 'verified'; email: string; userId: string | null }
  | {
      kind: 'refused';
      reason: EmailCodeReason;
      extras?: EmailCodeRefusalExtras;
    };

interface RequesterStatsRow {
  count: number;
  oldest: Date | string | null;
  latest: Date | string | null;
}

interface AddressSendStatsRow {
  sharedCount: number;
  sharedOldest: Date | string | null;
  trustedCount: number;
  trustedOldest: Date | string | null;
}

/** The bucket a send draws on (SEC-11). */
type SendBucket = 'shared' | 'trusted';

const REQUESTER_STATS_SQL = `SELECT count(*)::int AS "count", min(created_at) AS "oldest", max(created_at) AS "latest"
FROM email_sign_in_challenges
WHERE requester_hash = $1 AND email = $2 AND purpose = $3 AND created_at > $4`;

// Counted per purpose: anonymous sign-in requests can only spend the sign-in
// budget, so they leave the signed-in member's reauth codes untouched. Both
// buckets come back from one query on every request, trusted or untrusted, so
// the work a request costs reads the same for every address.
const ADDRESS_SEND_STATS_SQL = `SELECT
  count(*) FILTER (WHERE NOT is_trusted_send)::int AS "sharedCount",
  min(created_at) FILTER (WHERE NOT is_trusted_send) AS "sharedOldest",
  count(*) FILTER (WHERE is_trusted_send)::int AS "trustedCount",
  min(created_at) FILTER (WHERE is_trusted_send) AS "trustedOldest"
FROM email_sign_in_challenges WHERE email = $1 AND purpose = $2 AND created_at > $3`;

const SUPERSEDE_WHERE_SQL =
  'requester_hash = :requesterHash AND email = :email AND purpose = :purpose AND id <> :id AND consumed_at IS NULL AND superseded_at IS NULL';

const SIX_DIGIT_CODE = /^\d{6}$/;

/** Codes one address may receive for this purpose in the 24-hour window,
 *  from the shared cap. */
function addressSendLimit(purpose: EmailSignInChallengePurpose): number {
  return purpose === EmailSignInChallengePurpose.JoinRequest
    ? EMAIL_CODE_JOIN_REQUEST_ADDRESS_SEND_LIMIT
    : EMAIL_CODE_ADDRESS_SEND_LIMIT;
}

/** The reserved trusted-requester allowance for this purpose (SEC-11). */
function trustedAddressSendLimit(purpose: EmailSignInChallengePurpose): number {
  return purpose === EmailSignInChallengePurpose.JoinRequest
    ? EMAIL_CODE_JOIN_REQUEST_TRUSTED_ADDRESS_SEND_LIMIT
    : EMAIL_CODE_TRUSTED_ADDRESS_SEND_LIMIT;
}

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of two hex digests. */
function hexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

/** An error's class name for a log line. Its message may carry an address, so it stays out of logs. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function refuse(
  reason: EmailCodeReason,
  extras?: EmailCodeRefusalExtras,
): VerifyOutcome {
  return { kind: 'refused', reason, extras };
}

/**
 * The bucket a send draws on, or null when every bucket open to this
 * requester is spent (SEC-11). A trusted requester spends its reserved
 * allowance first and falls back to the shared cap, so it never fares worse
 * than an untrusted one. An untrusted requester has the shared cap alone.
 */
function pickSendBucket(
  stats: AddressSendStatsRow,
  purpose: EmailSignInChallengePurpose,
  isTrustedRequester: boolean,
): SendBucket | null {
  if (
    isTrustedRequester &&
    stats.trustedCount < trustedAddressSendLimit(purpose)
  ) {
    return 'trusted';
  }
  return stats.sharedCount < addressSendLimit(purpose) ? 'shared' : null;
}

/**
 * When the first bucket open to this requester frees a slot: the shared cap's
 * oldest send ages out of the 24-hour window, or for a trusted requester the
 * earlier of that and the reserve's oldest send. Both refusals carry the same
 * `too_many_codes` reason.
 */
function addressRetryAt(
  stats: AddressSendStatsRow,
  isTrustedRequester: boolean,
  now: Date,
): Date {
  const sharedRetryAt = addMs(
    toDate(stats.sharedOldest) ?? now,
    EMAIL_CODE_ADDRESS_WINDOW_MS,
  );
  if (!isTrustedRequester) return sharedRetryAt;
  const trustedRetryAt = addMs(
    toDate(stats.trustedOldest) ?? now,
    EMAIL_CODE_ADDRESS_WINDOW_MS,
  );
  return trustedRetryAt < sharedRetryAt ? trustedRetryAt : sharedRetryAt;
}

/**
 * Issues and checks 6-digit email sign-in codes. A code is stored only as an
 * HMAC of `challengeId:code`; the address is normalized before every count,
 * insert and send; a correct code is spent only by `consumeChallenge`, which
 * the controller calls once the sign-in, the reauth or the join request has
 * succeeded.
 *
 * Wrong guesses are limited per challenge (3 tries) and per address through
 * the shared send cap (30 codes per purpose per 24 hours, 10 for join-request
 * codes), so the codes a stranger can get for one address and purpose in a
 * day take at most `EMAIL_CODE_ADDRESS_WRONG_GUESS_BOUND` wrong guesses
 * (`EMAIL_CODE_JOIN_REQUEST_WRONG_GUESS_BOUND` for join requests). A
 * challenge only takes guesses from the requester it was issued to, so a
 * stranger burning their own codes leaves the member's open code usable.
 *
 * SEC-11: a browser holding a valid trusted-requester cookie for the address
 * also draws on a reserved allowance (10 sign-in, 5 join-request codes a day)
 * that requests without that cookie never count against, so a stranger who
 * spends the shared cap leaves the member able to get a code. A refusal from
 * either bucket is the same `too_many_codes` with `retryAt`.
 */
@Injectable()
export class EmailCodeService {
  private readonly logger = new Logger(EmailCodeService.name);
  private readonly codeKey: Buffer;
  private readonly trustedRequesterKey: Buffer;

  constructor(
    @InjectRepository(EmailSignInChallenge)
    private readonly challenges: Repository<EmailSignInChallenge>,
    private readonly dataSource: DataSource,
    config: ConfigService,
    private readonly mailer: EmailCodeMailer,
    private readonly users: UsersService,
  ) {
    this.codeKey = deriveEmailCodeKey(
      config.get<string>('email.codeSecret'),
      config.get<string>('auth.jwtAccessSecret'),
      config.get<string>('app.nodeEnv'),
    );
    this.trustedRequesterKey = deriveEmailCodeTrustedRequesterKey(
      config.get<string>('email.codeSecret'),
      config.get<string>('auth.jwtAccessSecret'),
      config.get<string>('app.nodeEnv'),
    );
  }

  /**
   * A fresh trusted-requester cookie value for an address the browser has
   * just proved it holds (SEC-11). The controller sets it after a sign-in or
   * a join request succeeds with a code for that address.
   */
  mintTrustedRequesterToken(email: string): string {
    return mintTrustedRequesterToken(
      this.trustedRequesterKey,
      normalizeEmailAddress(email),
      new Date(),
    );
  }

  async issueSignInChallenge(input: {
    rawEmail: string;
    requesterKey: string;
    locale: EmailCodeLocale;
    isRegistration?: boolean;
    /** The `email_code_trusted` cookie the browser presented, if any. */
    trustedRequesterToken?: string;
  }): Promise<IssuedEmailCode> {
    const email = normalizeEmailAddress(input.rawEmail);
    if (!isDeliverableEmailAddress(email)) {
      throw new EmailCodeRefusedError('email_invalid');
    }
    // A system account answers the same shape and is sent nothing.
    const owner = await this.users.findByEmailForSignIn(email);
    return this.issue({
      purpose: EmailSignInChallengePurpose.SignIn,
      email,
      userId: null,
      requesterKey: input.requesterKey,
      locale: input.locale,
      isRegistration: input.isRegistration,
      shouldDeliver: !owner?.isSystem,
      isTrustedRequester: this.isTrustedRequesterFor(
        input.trustedRequesterToken,
        email,
      ),
    });
  }

  /**
   * SEC-10: a code that proves the applicant controls the address on a join
   * request, before anything is filed in its name. Every address gets the
   * same answer and the same email: this never looks at join requests or
   * accounts, so the reply says nothing about whether the address applied,
   * was declined or belongs to a member. Its own purpose keeps its own,
   * tighter, per-address send cap, and a join-request code can never be typed
   * back on the sign-in or reauth routes.
   */
  async issueJoinRequestChallenge(input: {
    rawEmail: string;
    requesterKey: string;
    locale: EmailCodeLocale;
    /** The `email_code_trusted` cookie the browser presented, if any. */
    trustedRequesterToken?: string;
  }): Promise<IssuedEmailCode> {
    const email = normalizeEmailAddress(input.rawEmail);
    if (!isDeliverableEmailAddress(email)) {
      throw new EmailCodeRefusedError('email_invalid');
    }
    return await this.issue({
      purpose: EmailSignInChallengePurpose.JoinRequest,
      email,
      userId: null,
      requesterKey: input.requesterKey,
      locale: input.locale,
      shouldDeliver: true,
      isTrustedRequester: this.isTrustedRequesterFor(
        input.trustedRequesterToken,
        email,
      ),
    });
  }

  issueReauthChallenge(input: {
    userId: string;
    email: string;
    locale: EmailCodeLocale;
  }): Promise<IssuedEmailCode> {
    return this.issue({
      purpose: EmailSignInChallengePurpose.Reauth,
      email: normalizeEmailAddress(input.email),
      userId: input.userId,
      // The signed-in routes carry no requester cookie, so the member is the requester.
      requesterKey: `user:${input.userId}`,
      locale: input.locale,
      shouldDeliver: true,
      // A signed-in member's reauth codes have their own purpose budget,
      // which anonymous requests cannot reach.
      isTrustedRequester: false,
    });
  }

  async verifyChallenge(input: {
    challengeId: string;
    code: string;
    purpose: EmailSignInChallengePurpose;
    requesterKey: string;
    userId?: string;
  }): Promise<VerifiedEmailCode> {
    const { challengeId, code, purpose, requesterKey, userId } = input;
    if (!isUUID(challengeId) || !requesterKey) {
      throw new EmailCodeRefusedError('code_incorrect', {
        attemptsLeft: EMAIL_CODE_UNKNOWN_CHALLENGE_ATTEMPTS_LEFT,
      });
    }
    const requesterHash = sha256Hex(requesterKey);
    const now = new Date();

    const outcome = await this.dataSource.transaction(
      async (manager): Promise<VerifyOutcome> => {
        const repository = manager.getRepository(EmailSignInChallenge);
        const row = await repository.findOne({
          where: { id: challengeId },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !row ||
          row.purpose !== purpose ||
          !hexEqual(row.requesterHash, requesterHash) ||
          (userId && row.userId !== userId)
        ) {
          return refuse('code_incorrect', {
            attemptsLeft: EMAIL_CODE_UNKNOWN_CHALLENGE_ATTEMPTS_LEFT,
          });
        }
        if (row.consumedAt) return refuse('code_already_used');
        if (row.supersededAt) return refuse('code_replaced');
        if (row.failedAttempts >= EMAIL_CODE_MAX_WRONG_ATTEMPTS) {
          return refuse('code_used_up');
        }
        if (new Date(row.expiresAt).getTime() <= now.getTime()) {
          return refuse('code_expired');
        }

        if (
          typeof code === 'string' &&
          SIX_DIGIT_CODE.test(code) &&
          hexEqual(row.codeHash, this.hashCode(row.id, code))
        ) {
          // No write: the challenge stays open until consumeChallenge, so a signup gate refusal leaves it reusable.
          return { kind: 'verified', email: row.email, userId: row.userId };
        }

        const failed = row.failedAttempts + 1;
        await repository.update({ id: row.id }, { failedAttempts: failed });
        return failed >= EMAIL_CODE_MAX_WRONG_ATTEMPTS
          ? refuse('code_used_up')
          : refuse('code_incorrect', {
              attemptsLeft: EMAIL_CODE_MAX_WRONG_ATTEMPTS - failed,
            });
      },
    );

    // Thrown only after the transaction has committed, so a counted wrong try sticks.
    if (outcome.kind === 'refused') {
      if (outcome.reason === 'code_used_up') {
        this.logger.warn(
          `Sign-in code refused: reason=${outcome.reason} challengeId=${challengeId}`,
        );
      }
      throw new EmailCodeRefusedError(outcome.reason, outcome.extras);
    }
    return { email: outcome.email, userId: outcome.userId };
  }

  async consumeChallenge(challengeId: string): Promise<boolean> {
    const result = await this.challenges.update(
      { id: challengeId, consumedAt: IsNull() },
      { consumedAt: new Date() },
    );
    return (result.affected ?? 0) > 0;
  }

  private async issue(input: IssueInput): Promise<IssuedEmailCode> {
    const { purpose, email, userId, locale, isRegistration, shouldDeliver } =
      input;
    const requesterHash = sha256Hex(input.requesterKey);
    const now = new Date();
    const challengeId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresAt = addMs(now, EMAIL_CODE_TTL_MS);

    await this.dataSource.transaction(async (manager) => {
      // Serializes every request for this address, so two clicks in the same
      // instant cannot both pass the cooldown. Runs before any count. Keyed on
      // a digest so a slow or failed lock query logs no address.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `email-code:${sha256Hex(email)}`,
      ]);

      const requester = await this.requesterStats(
        manager,
        requesterHash,
        email,
        purpose,
        now,
      );
      const latest = toDate(requester.latest);
      if (latest) {
        const resendAvailableAt = addMs(latest, EMAIL_CODE_RESEND_COOLDOWN_MS);
        if (resendAvailableAt.getTime() > now.getTime()) {
          throw new EmailCodeRefusedError('resend_too_soon', {
            resendAvailableAt,
          });
        }
      }
      if (requester.count >= EMAIL_CODE_REQUESTER_WINDOW_LIMIT) {
        throw new EmailCodeRefusedError('too_many_codes', {
          retryAt: addMs(
            toDate(requester.oldest) ?? now,
            EMAIL_CODE_REQUESTER_WINDOW_MS,
          ),
        });
      }

      const address = await this.addressSendStats(manager, email, purpose, now);
      const bucket = pickSendBucket(address, purpose, input.isTrustedRequester);
      if (!bucket) {
        throw new EmailCodeRefusedError('too_many_codes', {
          retryAt: addressRetryAt(address, input.isTrustedRequester, now),
        });
      }

      await manager.getRepository(EmailSignInChallenge).insert({
        id: challengeId,
        purpose,
        email,
        userId,
        requesterHash,
        codeHash: this.hashCode(challengeId, code),
        failedAttempts: 0,
        isTrustedSend: bucket === 'trusted',
        expiresAt,
        createdAt: now,
      });
    });

    if (shouldDeliver) {
      const sent = await this.send({
        email,
        code,
        locale,
        isRegistration,
        isJoinRequest: purpose === EmailSignInChallengePurpose.JoinRequest,
        challengeId,
      });
      if (!sent.delivered) {
        // Older codes stay open: nothing has been superseded yet.
        try {
          await this.challenges.delete({ id: challengeId });
        } catch (error) {
          // The orphan row holds a code nobody received and expires with the TTL.
          this.logger.warn(
            `Sign-in code row delete failed after a failed send: name=${errorName(error)} challengeId=${challengeId}`,
          );
        }
        throw new EmailCodeRefusedError('email_send_failed');
      }
    }

    try {
      await this.challenges
        .createQueryBuilder()
        .update(EmailSignInChallenge)
        .set({ supersededAt: now })
        .where(SUPERSEDE_WHERE_SQL, {
          requesterHash,
          email,
          purpose,
          id: challengeId,
        })
        .execute();
    } catch (error) {
      // The email already went out, so the person still gets this challenge.
      // Older codes stay open until they expire with the TTL.
      this.logger.warn(
        `Sign-in code supersede failed: name=${errorName(error)} challengeId=${challengeId}`,
      );
    }

    this.logger.log(
      `Issued sign-in code challengeId=${challengeId} purpose=${purpose} delivered=${shouldDeliver}`,
    );
    return {
      challengeId,
      expiresAt,
      resendAvailableAt: addMs(now, EMAIL_CODE_RESEND_COOLDOWN_MS),
    };
  }

  /** The mailer reports failures as a value; a throw is treated as unavailable. */
  private async send(input: {
    email: string;
    code: string;
    locale: EmailCodeLocale;
    isRegistration?: boolean;
    isJoinRequest: boolean;
    challengeId: string;
  }): Promise<SignInCodeSendResult> {
    try {
      return await this.mailer.sendSignInCode({
        to: input.email,
        code: input.code,
        minutes: EMAIL_CODE_TTL_MINUTES,
        locale: input.locale,
        isRegistration: input.isRegistration,
        isJoinRequest: input.isJoinRequest,
        challengeId: input.challengeId,
      });
    } catch (error) {
      this.logger.warn(
        `Sign-in code send threw: name=${errorName(error)} challengeId=${input.challengeId}`,
      );
      return { delivered: false, failure: 'resend_unavailable' };
    }
  }

  private hashCode(challengeId: string, code: string): string {
    return createHmac('sha256', this.codeKey)
      .update(`${challengeId}:${code}`)
      .digest('hex');
  }

  private async requesterStats(
    manager: EntityManager,
    requesterHash: string,
    email: string,
    purpose: EmailSignInChallengePurpose,
    now: Date,
  ): Promise<RequesterStatsRow> {
    const rows: RequesterStatsRow[] = await manager.query(REQUESTER_STATS_SQL, [
      requesterHash,
      email,
      purpose,
      addMs(now, -EMAIL_CODE_REQUESTER_WINDOW_MS),
    ]);
    return rows[0] ?? { count: 0, oldest: null, latest: null };
  }

  private async addressSendStats(
    manager: EntityManager,
    email: string,
    purpose: EmailSignInChallengePurpose,
    now: Date,
  ): Promise<AddressSendStatsRow> {
    const rows: AddressSendStatsRow[] = await manager.query(
      ADDRESS_SEND_STATS_SQL,
      [email, purpose, addMs(now, -EMAIL_CODE_ADDRESS_WINDOW_MS)],
    );
    return (
      rows[0] ?? {
        sharedCount: 0,
        sharedOldest: null,
        trustedCount: 0,
        trustedOldest: null,
      }
    );
  }

  private isTrustedRequesterFor(
    token: string | undefined,
    normalizedEmail: string,
  ): boolean {
    return isTrustedRequesterToken(
      this.trustedRequesterKey,
      token,
      normalizedEmail,
      new Date(),
    );
  }
}

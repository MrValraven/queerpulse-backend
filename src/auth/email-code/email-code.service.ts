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
import { deriveEmailCodeKey } from './email-code-secret';
import {
  EMAIL_CODE_ADDRESS_SEND_LIMIT,
  EMAIL_CODE_ADDRESS_WINDOW_MS,
  EMAIL_CODE_ADDRESS_WRONG_GUESS_LIMIT,
  EMAIL_CODE_MAX_WRONG_ATTEMPTS,
  EMAIL_CODE_REQUESTER_WINDOW_LIMIT,
  EMAIL_CODE_REQUESTER_WINDOW_MS,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
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
  shouldDeliver: boolean;
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
  count: number;
  oldest: Date | string | null;
}

interface AddressGuessStatsRow {
  total: number;
  oldest: Date | string | null;
}

const REQUESTER_STATS_SQL = `SELECT count(*)::int AS "count", min(created_at) AS "oldest", max(created_at) AS "latest"
FROM email_sign_in_challenges
WHERE requester_hash = $1 AND email = $2 AND purpose = $3 AND created_at > $4`;

const ADDRESS_SEND_STATS_SQL = `SELECT count(*)::int AS "count", min(created_at) AS "oldest"
FROM email_sign_in_challenges WHERE email = $1 AND created_at > $2`;

const ADDRESS_GUESS_STATS_SQL = `SELECT coalesce(sum(failed_attempts), 0)::int AS "total", min(created_at) FILTER (WHERE failed_attempts > 0) AS "oldest"
FROM email_sign_in_challenges WHERE email = $1 AND created_at > $2`;

const SUPERSEDE_WHERE_SQL =
  'requester_hash = :requesterHash AND email = :email AND purpose = :purpose AND id <> :id AND consumed_at IS NULL AND superseded_at IS NULL';

const SIX_DIGIT_CODE = /^\d{6}$/;

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
 * Issues and checks 6-digit email sign-in codes. A code is stored only as an
 * HMAC of `challengeId:code`; the address is normalized before every count,
 * insert and send; a correct code is spent only by `consumeChallenge`, which
 * the controller calls once the sign-in or reauth has succeeded.
 */
@Injectable()
export class EmailCodeService {
  private readonly logger = new Logger(EmailCodeService.name);
  private readonly codeKey: Buffer;

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
  }

  async issueSignInChallenge(input: {
    rawEmail: string;
    requesterKey: string;
    locale: EmailCodeLocale;
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
      shouldDeliver: !owner?.isSystem,
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

        const guesses = await this.addressGuessStats(manager, row.email, now);
        if (guesses.total >= EMAIL_CODE_ADDRESS_WRONG_GUESS_LIMIT) {
          return refuse('too_many_attempts', {
            retryAt: addMs(
              toDate(guesses.oldest) ?? now,
              EMAIL_CODE_ADDRESS_WINDOW_MS,
            ),
          });
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
      if (
        outcome.reason === 'code_used_up' ||
        outcome.reason === 'too_many_attempts'
      ) {
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
    const { purpose, email, userId, locale, shouldDeliver } = input;
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

      const address = await this.addressSendStats(manager, email, now);
      if (address.count >= EMAIL_CODE_ADDRESS_SEND_LIMIT) {
        throw new EmailCodeRefusedError('too_many_codes', {
          retryAt: addMs(
            toDate(address.oldest) ?? now,
            EMAIL_CODE_ADDRESS_WINDOW_MS,
          ),
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
        expiresAt,
        createdAt: now,
      });
    });

    if (shouldDeliver) {
      const sent = await this.send({ email, code, locale, challengeId });
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
    challengeId: string;
  }): Promise<SignInCodeSendResult> {
    try {
      return await this.mailer.sendSignInCode({
        to: input.email,
        code: input.code,
        minutes: EMAIL_CODE_TTL_MINUTES,
        locale: input.locale,
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
    now: Date,
  ): Promise<AddressSendStatsRow> {
    const rows: AddressSendStatsRow[] = await manager.query(
      ADDRESS_SEND_STATS_SQL,
      [email, addMs(now, -EMAIL_CODE_ADDRESS_WINDOW_MS)],
    );
    return rows[0] ?? { count: 0, oldest: null };
  }

  private async addressGuessStats(
    manager: EntityManager,
    email: string,
    now: Date,
  ): Promise<AddressGuessStatsRow> {
    const rows: AddressGuessStatsRow[] = await manager.query(
      ADDRESS_GUESS_STATS_SQL,
      [email, addMs(now, -EMAIL_CODE_ADDRESS_WINDOW_MS)],
    );
    return rows[0] ?? { total: 0, oldest: null };
  }
}

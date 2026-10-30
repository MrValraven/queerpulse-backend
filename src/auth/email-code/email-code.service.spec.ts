import { HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { UsersService } from '../../users/users.service';
import { EmailCodeRefusedError } from './email-code-refusal';
import { deriveEmailCodeKey } from './email-code-secret';
import { EmailCodeMailer, SignInCodeSendResult } from './email-code.mailer';
import { EmailCodeService } from './email-code.service';
import {
  EmailSignInChallenge,
  EmailSignInChallengePurpose,
} from './email-sign-in-challenge.entity';

const CODE_SECRET = 'email-code-secret-for-the-service-spec';
const JWT_SECRET = 'jwt-access-secret-for-the-service-spec';
const KEY = deriveEmailCodeKey(CODE_SECRET, JWT_SECRET, 'test');

const CHALLENGE_ID = '0b5f2c1e-8a4d-4f6b-9c3e-2d7a1b0e9f45';
const NOW = new Date('2026-10-26T12:00:00Z');

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const codeHashFor = (challengeId: string, code: string) =>
  createHmac('sha256', KEY).update(`${challengeId}:${code}`).digest('hex');

interface RequesterStats {
  count: number;
  oldest: Date | null;
  latest: Date | null;
}
interface AddressStats {
  count: number;
  oldest: Date | null;
}
interface GuessStats {
  total: number;
  oldest: Date | null;
}

const challengeRow = (
  overrides: Partial<EmailSignInChallenge> = {},
): EmailSignInChallenge => ({
  id: CHALLENGE_ID,
  purpose: EmailSignInChallengePurpose.SignIn,
  email: 'sam@example.com',
  userId: null,
  requesterHash: sha256('cookie-1'),
  codeHash: codeHashFor(CHALLENGE_ID, '123456'),
  failedAttempts: 0,
  expiresAt: new Date('2026-10-26T12:05:00Z'),
  consumedAt: null,
  supersededAt: null,
  createdAt: new Date('2026-10-26T11:55:00Z'),
  ...overrides,
});

/** The first argument of a mock's first call; throws when the mock was never called. */
function firstCallArgument(mock: jest.Mock): unknown {
  const firstCall = (mock.mock.calls as unknown[][])[0];
  if (!firstCall) throw new Error('expected the mock to have been called');
  return firstCall[0];
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EmailCodeRefusedError) return error;
    throw error;
  }
  throw new Error('expected an EmailCodeRefusedError');
}

describe('EmailCodeService', () => {
  let service: EmailCodeService;
  let events: string[];
  let requesterStats: RequesterStats;
  let addressStats: AddressStats;
  let guessStats: GuessStats;
  let row: EmailSignInChallenge | null;
  let manager: { query: jest.Mock; getRepository: jest.Mock };
  let managerRepository: {
    findOne: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
  };
  let supersedeQueryBuilder: Record<string, jest.Mock> & {
    execute: jest.Mock;
  };
  let challenges: {
    delete: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let mailer: { sendSignInCode: jest.Mock };
  let users: { findByEmailForSignIn: jest.Mock };
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    events = [];
    requesterStats = { count: 0, oldest: null, latest: null };
    addressStats = { count: 0, oldest: null };
    guessStats = { total: 0, oldest: null };
    row = challengeRow();

    managerRepository = {
      findOne: jest.fn(() => Promise.resolve(row)),
      update: jest.fn(() => {
        events.push('update');
        return Promise.resolve({ affected: 1 });
      }),
      insert: jest.fn(() => Promise.resolve({ identifiers: [] })),
    };
    manager = {
      query: jest.fn((sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
        if (sql.includes('requester_hash'))
          return Promise.resolve([requesterStats]);
        if (sql.includes('failed_attempts'))
          return Promise.resolve([guessStats]);
        return Promise.resolve([addressStats]);
      }),
      getRepository: jest.fn(() => managerRepository),
    };
    dataSource = {
      transaction: jest.fn(
        async (callback: (entityManager: typeof manager) => unknown) => {
          events.push('transaction:start');
          const result = await callback(manager);
          events.push('transaction:resolved');
          return result;
        },
      ),
    };

    supersedeQueryBuilder = {
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    for (const method of ['update', 'set', 'where']) {
      supersedeQueryBuilder[method] = jest
        .fn()
        .mockReturnValue(supersedeQueryBuilder);
    }
    challenges = {
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => supersedeQueryBuilder),
    };

    const configValues: Record<string, string> = {
      'email.codeSecret': CODE_SECRET,
      'auth.jwtAccessSecret': JWT_SECRET,
      'app.nodeEnv': 'test',
    };
    const config = {
      get: jest.fn((path: string) => configValues[path]),
    };
    mailer = {
      sendSignInCode: jest.fn((): Promise<SignInCodeSendResult> =>
        Promise.resolve({ delivered: true, emailId: 're_1' }),
      ),
    };
    users = { findByEmailForSignIn: jest.fn().mockResolvedValue(null) };

    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    service = new EmailCodeService(
      challenges as unknown as Repository<EmailSignInChallenge>,
      dataSource as unknown as DataSource,
      config as unknown as ConfigService,
      mailer as unknown as EmailCodeMailer,
      users as unknown as UsersService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const issue = (rawEmail = 'sam@example.com') =>
    service.issueSignInChallenge({
      rawEmail,
      requesterKey: 'cookie-1',
      locale: 'en',
    });

  const verify = (
    code: string,
    overrides: Partial<{
      challengeId: string;
      purpose: EmailSignInChallengePurpose;
      requesterKey: string;
      userId: string;
    }> = {},
  ) =>
    service.verifyChallenge({
      challengeId: CHALLENGE_ID,
      code,
      purpose: EmailSignInChallengePurpose.SignIn,
      requesterKey: 'cookie-1',
      ...overrides,
    });

  const insertedRow = () =>
    firstCallArgument(managerRepository.insert) as EmailSignInChallenge;
  const mailedCode = () =>
    (firstCallArgument(mailer.sendSignInCode) as { code: string }).code;

  describe('issueSignInChallenge', () => {
    it('refuses an address that is not deliverable with email_invalid (400)', async () => {
      const refusal = await refusalOf(issue('  not-an-address '));

      expect(refusal.reason).toBe('email_invalid');
      expect(refusal.getStatus()).toBe(400);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(users.findByEmailForSignIn).not.toHaveBeenCalled();
      expect(mailer.sendSignInCode).not.toHaveBeenCalled();
    });

    it('normalizes the address before counting, storing and sending', async () => {
      await issue(' Sam@Example.COM ');

      expect(users.findByEmailForSignIn).toHaveBeenCalledWith(
        'sam@example.com',
      );
      const countParams = manager.query.mock.calls
        .slice(1)
        .map((call: unknown[]) => call[1] as unknown[]);
      for (const params of countParams) {
        expect(params).toContain('sam@example.com');
      }
      expect(insertedRow().email).toBe('sam@example.com');
      expect(mailer.sendSignInCode).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'sam@example.com', minutes: 10 }),
      );
    });

    it('hands isRegistration to the mailer and leaves it unset when the flag is absent', async () => {
      await service.issueSignInChallenge({
        rawEmail: 'sam@example.com',
        requesterKey: 'cookie-1',
        locale: 'en',
        isRegistration: true,
      });
      expect(mailer.sendSignInCode).toHaveBeenLastCalledWith(
        expect.objectContaining({ isRegistration: true }),
      );

      await issue('lee@example.com');
      expect(mailer.sendSignInCode).toHaveBeenLastCalledWith(
        expect.objectContaining({ isRegistration: undefined }),
      );
    });

    it('takes the per-address advisory lock before any count', async () => {
      await issue();

      // Keyed on a digest, so a slow or failed lock query logs no address.
      expect(manager.query.mock.calls[0]).toEqual([
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`email-code:${sha256('sam@example.com')}`],
      ]);
      expect(manager.query.mock.calls.length).toBeGreaterThan(1);
    });

    it('counts the requester over 15 minutes and the address over 24 hours', async () => {
      await issue();

      const calls = manager.query.mock.calls as [string, unknown[]][];
      const requesterCall = calls.find(([sql]) =>
        sql.includes('requester_hash'),
      );
      const addressCall = calls.find(
        ([sql]) =>
          !sql.includes('requester_hash') &&
          !sql.includes('pg_advisory_xact_lock'),
      );
      expect(requesterCall?.[1]).toEqual([
        sha256('cookie-1'),
        'sam@example.com',
        EmailSignInChallengePurpose.SignIn,
        new Date('2026-10-26T11:45:00.000Z'),
      ]);
      expect(addressCall?.[1]).toEqual([
        'sam@example.com',
        new Date('2026-10-25T12:00:00.000Z'),
      ]);
    });

    it('stores only an HMAC of challengeId:code', async () => {
      await issue();

      const inserted = insertedRow();
      const code = mailedCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(inserted.codeHash).toBe(
        createHmac('sha256', KEY)
          .update(inserted.id + ':' + code)
          .digest('hex'),
      );
      for (const value of Object.values(inserted)) {
        expect(value).not.toBe(code);
      }
    });

    it("answers resend_too_soon (429) with resendAvailableAt 60 s after this requester's last code", async () => {
      requesterStats = {
        count: 1,
        oldest: new Date('2026-10-26T11:59:30Z'),
        latest: new Date('2026-10-26T11:59:30Z'),
      };

      const refusal = await refusalOf(issue());

      expect(refusal.reason).toBe('resend_too_soon');
      expect(refusal.getStatus()).toBe(429);
      expect(refusal.getResponse()).toEqual(
        expect.objectContaining({
          resendAvailableAt: '2026-10-26T12:00:30.000Z',
        }),
      );
      expect(managerRepository.insert).not.toHaveBeenCalled();
      expect(mailer.sendSignInCode).not.toHaveBeenCalled();
    });

    it('answers too_many_codes after 3 codes in 15 minutes from this requester', async () => {
      requesterStats = {
        count: 3,
        oldest: new Date('2026-10-26T11:50:00Z'),
        latest: new Date('2026-10-26T11:55:00Z'),
      };

      const refusal = await refusalOf(issue());

      expect(refusal.reason).toBe('too_many_codes');
      expect(refusal.getStatus()).toBe(429);
      expect(refusal.getResponse()).toEqual(
        expect.objectContaining({ retryAt: '2026-10-26T12:05:00.000Z' }),
      );
      expect(managerRepository.insert).not.toHaveBeenCalled();
    });

    it('answers too_many_codes after 30 codes to the address in 24 hours', async () => {
      addressStats = { count: 30, oldest: new Date('2026-10-25T13:00:00Z') };

      const refusal = await refusalOf(issue());

      expect(refusal.reason).toBe('too_many_codes');
      expect(refusal.getResponse()).toEqual(
        expect.objectContaining({ retryAt: '2026-10-26T13:00:00.000Z' }),
      );
      expect(managerRepository.insert).not.toHaveBeenCalled();
    });

    it('sends nothing for a system account and answers the same shape', async () => {
      users.findByEmailForSignIn.mockResolvedValue({ isSystem: true });

      const issued = await issue();

      expect(mailer.sendSignInCode).not.toHaveBeenCalled();
      expect(issued).toEqual({
        challengeId: insertedRow().id,
        expiresAt: new Date('2026-10-26T12:10:00Z'),
        resendAvailableAt: new Date('2026-10-26T12:01:00Z'),
      });
    });

    it('deletes the new challenge and answers email_send_failed (503) when the send fails, leaving older codes open', async () => {
      mailer.sendSignInCode.mockResolvedValue({
        delivered: false,
        failure: 'resend_unavailable',
      });

      const refusal = await refusalOf(issue());

      expect(refusal.reason).toBe('email_send_failed');
      expect(refusal.getStatus()).toBe(503);
      expect(challenges.delete).toHaveBeenCalledWith({ id: insertedRow().id });
      expect(challenges.createQueryBuilder).not.toHaveBeenCalled();
      expect(supersedeQueryBuilder.execute).not.toHaveBeenCalled();
    });

    it('answers email_send_failed and logs ids only when the mailer throws', async () => {
      mailer.sendSignInCode.mockRejectedValue(
        new TypeError('fetch failed for sam@example.com'),
      );

      const refusal = await refusalOf(issue());

      expect(refusal.reason).toBe('email_send_failed');
      expect(challenges.delete).toHaveBeenCalledWith({ id: insertedRow().id });
      expect(warnSpy).toHaveBeenCalledWith(
        `Sign-in code send threw: name=TypeError challengeId=${insertedRow().id}`,
      );
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain('sam@example.com');
    });

    it('still answers email_send_failed when deleting the unsent challenge fails', async () => {
      mailer.sendSignInCode.mockResolvedValue({
        delivered: false,
        failure: 'resend_rejected',
      });
      challenges.delete.mockRejectedValue(new Error('connection lost'));

      const refusal = await refusalOf(issue());

      expect(refusal.reason).toBe('email_send_failed');
      expect(refusal.getStatus()).toBe(503);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`challengeId=${insertedRow().id}`),
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
        'connection lost',
      );
      expect(supersedeQueryBuilder.execute).not.toHaveBeenCalled();
    });

    it("supersedes only this requester's older open codes for the address and purpose after a send", async () => {
      const issued = await issue();

      expect(supersedeQueryBuilder.set).toHaveBeenCalledWith({
        supersededAt: NOW,
      });
      expect(supersedeQueryBuilder.where).toHaveBeenCalledWith(
        'requester_hash = :requesterHash AND email = :email AND purpose = :purpose AND id <> :id AND consumed_at IS NULL AND superseded_at IS NULL',
        {
          requesterHash: sha256('cookie-1'),
          email: 'sam@example.com',
          purpose: EmailSignInChallengePurpose.SignIn,
          id: issued.challengeId,
        },
      );
      expect(supersedeQueryBuilder.execute).toHaveBeenCalled();
      expect(issued).toEqual({
        challengeId: insertedRow().id,
        expiresAt: new Date('2026-10-26T12:10:00Z'),
        resendAvailableAt: new Date('2026-10-26T12:01:00Z'),
      });
      expect(logSpy).toHaveBeenCalledWith(
        `Issued sign-in code challengeId=${issued.challengeId} purpose=sign_in delivered=true`,
      );
    });

    it('still returns the issued challenge and logs ids only when the supersede fails after a send', async () => {
      supersedeQueryBuilder.execute.mockRejectedValue(
        new TypeError('update failed for sam@example.com'),
      );

      const issued = await issue();

      expect(mailer.sendSignInCode).toHaveBeenCalled();
      expect(issued).toEqual({
        challengeId: insertedRow().id,
        expiresAt: new Date('2026-10-26T12:10:00Z'),
        resendAvailableAt: new Date('2026-10-26T12:01:00Z'),
      });
      expect(warnSpy).toHaveBeenCalledWith(
        `Sign-in code supersede failed: name=TypeError challengeId=${insertedRow().id}`,
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
        'sam@example.com',
      );
    });
  });

  describe('issueReauthChallenge', () => {
    it('issueReauthChallenge keys the requester on the member and stores userId', async () => {
      await service.issueReauthChallenge({
        userId: 'u1',
        email: 'Sam@Example.com',
        locale: 'pt',
      });

      expect(users.findByEmailForSignIn).not.toHaveBeenCalled();
      expect(insertedRow()).toEqual(
        expect.objectContaining({
          purpose: EmailSignInChallengePurpose.Reauth,
          email: 'sam@example.com',
          userId: 'u1',
          requesterHash: sha256('user:u1'),
        }),
      );
      expect(mailer.sendSignInCode).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'sam@example.com', locale: 'pt' }),
      );
    });
  });

  describe('verifyChallenge', () => {
    it('answers code_incorrect with attemptsLeft 4 for a challenge id that is not a uuid, without a query', async () => {
      const refusal = await refusalOf(
        verify('123456', { challengeId: 'not-a-uuid' }),
      );

      expect(refusal.reason).toBe('code_incorrect');
      expect(refusal.getStatus()).toBe(400);
      expect(refusal.getResponse()).toEqual({
        reason: 'code_incorrect',
        message: 'code_incorrect',
        attemptsLeft: 4,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('answers code_incorrect when the requester cookie is missing, without a query', async () => {
      const refusal = await refusalOf(verify('123456', { requesterKey: '' }));

      expect(refusal.reason).toBe('code_incorrect');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('answers code_incorrect for a requester that did not ask for the challenge, without counting a try', async () => {
      row = challengeRow({ requesterHash: sha256('cookie-2') });

      const refusal = await refusalOf(verify('123456'));

      expect(refusal.reason).toBe('code_incorrect');
      expect(refusal.getResponse()).toEqual(
        expect.objectContaining({ attemptsLeft: 4 }),
      );
      expect(managerRepository.update).not.toHaveBeenCalled();
    });

    it('answers code_incorrect when a reauth challenge belongs to someone else', async () => {
      row = challengeRow({
        purpose: EmailSignInChallengePurpose.Reauth,
        userId: 'u2',
        requesterHash: sha256('user:u1'),
      });

      const refusal = await refusalOf(
        verify('123456', {
          purpose: EmailSignInChallengePurpose.Reauth,
          requesterKey: 'user:u1',
          userId: 'u1',
        }),
      );

      expect(refusal.reason).toBe('code_incorrect');
      expect(managerRepository.update).not.toHaveBeenCalled();
    });

    // Each row also carries every state checked after its own, so a passing
    // case proves the order the states are checked in.
    it.each([
      [
        'code_already_used',
        {
          consumedAt: new Date('2026-10-26T11:58:00Z'),
          supersededAt: new Date('2026-10-26T11:59:00Z'),
          failedAttempts: 5,
          expiresAt: new Date('2026-10-26T11:59:59Z'),
        },
      ],
      [
        'code_replaced',
        {
          supersededAt: new Date('2026-10-26T11:59:00Z'),
          failedAttempts: 5,
          expiresAt: new Date('2026-10-26T11:59:59Z'),
        },
      ],
      [
        'code_used_up',
        { failedAttempts: 5, expiresAt: new Date('2026-10-26T11:59:59Z') },
      ],
      ['code_expired', { expiresAt: new Date('2026-10-26T11:59:59Z') }],
    ])(
      'answers code_already_used, code_replaced, code_used_up and code_expired for those row states (%s)',
      async (reason, overrides) => {
        row = challengeRow(overrides);

        const refusal = await refusalOf(verify('123456'));

        expect(refusal.reason).toBe(reason);
        expect(refusal.getStatus()).toBe(400);
        expect(managerRepository.update).not.toHaveBeenCalled();
      },
    );

    it('answers too_many_attempts (429) with retryAt once the address has 50 wrong guesses in 24 hours', async () => {
      guessStats = { total: 50, oldest: new Date('2026-10-25T18:00:00Z') };

      const refusal = await refusalOf(verify('123456'));

      expect(refusal.reason).toBe('too_many_attempts');
      expect(refusal.getStatus()).toBe(429);
      expect(refusal.getResponse()).toEqual(
        expect.objectContaining({ retryAt: '2026-10-26T18:00:00.000Z' }),
      );
      expect(managerRepository.update).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        `Sign-in code refused: reason=too_many_attempts challengeId=${CHALLENGE_ID}`,
      );
    });

    it('accepts the right code without consuming it or counting a try', async () => {
      await expect(verify('123456')).resolves.toEqual({
        email: 'sam@example.com',
        userId: null,
      });

      expect(managerRepository.update).not.toHaveBeenCalled();
      expect(challenges.update).not.toHaveBeenCalled();
    });

    it('accepts the same right code again while the challenge is open', async () => {
      const first = await verify('123456');
      const second = await verify('123456');

      expect(second).toEqual(first);
      expect(managerRepository.update).not.toHaveBeenCalled();
    });

    it('counts a wrong code inside the transaction and throws after it commits', async () => {
      row = challengeRow({ failedAttempts: 2 });

      const refusal = await refusalOf(verify('654321'));

      expect(managerRepository.findOne).toHaveBeenCalledWith({
        where: { id: CHALLENGE_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(managerRepository.update).toHaveBeenCalledWith(
        { id: CHALLENGE_ID },
        { failedAttempts: 3 },
      );
      expect(refusal.reason).toBe('code_incorrect');
      expect(refusal.getResponse()).toEqual(
        expect.objectContaining({ attemptsLeft: 2 }),
      );
      expect(events).toEqual([
        'transaction:start',
        'update',
        'transaction:resolved',
      ]);
      const transactionResult = (
        dataSource.transaction.mock.results[0] as { value: Promise<unknown> }
      ).value;
      await expect(transactionResult).resolves.toBeDefined();
    });

    it('answers code_used_up on the fifth wrong code', async () => {
      row = challengeRow({ failedAttempts: 4 });

      const refusal = await refusalOf(verify('654321'));

      expect(managerRepository.update).toHaveBeenCalledWith(
        { id: CHALLENGE_ID },
        { failedAttempts: 5 },
      );
      expect(refusal.reason).toBe('code_used_up');
      expect(warnSpy).toHaveBeenCalledWith(
        `Sign-in code refused: reason=code_used_up challengeId=${CHALLENGE_ID}`,
      );
    });

    it('treats a code that is not six digits as a wrong try', async () => {
      const refusal = await refusalOf(verify('12a456'));

      expect(managerRepository.update).toHaveBeenCalledWith(
        { id: CHALLENGE_ID },
        { failedAttempts: 1 },
      );
      expect(refusal.reason).toBe('code_incorrect');
      expect(refusal.getResponse()).toEqual(
        expect.objectContaining({ attemptsLeft: 4 }),
      );
    });
  });

  describe('consumeChallenge', () => {
    it('consumeChallenge spends an open challenge once', async () => {
      challenges.update.mockResolvedValueOnce({ affected: 1 });
      await expect(service.consumeChallenge(CHALLENGE_ID)).resolves.toBe(true);
      expect(challenges.update).toHaveBeenCalledWith(
        { id: CHALLENGE_ID, consumedAt: IsNull() },
        { consumedAt: NOW },
      );

      challenges.update.mockResolvedValueOnce({ affected: 0 });
      await expect(service.consumeChallenge(CHALLENGE_ID)).resolves.toBe(false);
    });
  });

  describe('EmailCodeRefusedError', () => {
    it('EmailCodeRefusedError carries reason, message and ISO extras', () => {
      const error = new EmailCodeRefusedError('resend_too_soon', {
        resendAvailableAt: new Date('2026-10-26T12:00:30Z'),
      });

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getResponse()).toEqual({
        reason: 'resend_too_soon',
        message: 'resend_too_soon',
        resendAvailableAt: '2026-10-26T12:00:30.000Z',
      });
      expect(error.getStatus()).toBe(429);
    });
  });
});

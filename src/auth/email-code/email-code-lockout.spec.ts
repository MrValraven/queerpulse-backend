import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UsersService } from '../../users/users.service';
import { EmailCodeRefusedError } from './email-code-refusal';
import {
  EMAIL_CODE_ADDRESS_SEND_LIMIT,
  EMAIL_CODE_ADDRESS_WRONG_GUESS_BOUND,
  EMAIL_CODE_MAX_WRONG_ATTEMPTS,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
  EMAIL_CODE_TRUSTED_ADDRESS_SEND_LIMIT,
} from './email-code.constants';
import { EmailCodeMailer } from './email-code.mailer';
import { EmailCodeService } from './email-code.service';
import {
  EmailSignInChallenge,
  EmailSignInChallengePurpose,
} from './email-sign-in-challenge.entity';

/**
 * SEC-11: a stranger who drops the requester cookie on every request must not
 * be able to lock the member out of their own code, while the wrong guesses
 * the stranger can take against one address stay bounded by the send cap
 * times the per-code tries. Runs the real service against an in-memory
 * challenge table that answers the service's own queries.
 */

const ADDRESS = 'sam@example.com';
const MEMBER_COOKIE = 'member-browser-cookie';
const MEMBER_ID = '7d1c2b8e-3f4a-4c5d-9e6f-0a1b2c3d4e5f';
const NOW = new Date('2026-11-23T12:00:00Z');

interface StoredChallenge {
  id: string;
  purpose: EmailSignInChallengePurpose;
  email: string;
  userId: string | null;
  requesterHash: string;
  codeHash: string;
  failedAttempts: number;
  isTrustedSend: boolean;
  expiresAt: Date;
  consumedAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
}

interface SupersedeParameters {
  requesterHash: string;
  email: string;
  purpose: EmailSignInChallengePurpose;
  id: string;
}

interface FakeSupersedeBuilder {
  update: () => FakeSupersedeBuilder;
  set: (patch: { supersededAt: Date }) => FakeSupersedeBuilder;
  where: (sql: string, parameters: SupersedeParameters) => FakeSupersedeBuilder;
  execute: () => Promise<{ affected: number }>;
}

interface FakeChallengeTable {
  rows: StoredChallenge[];
  /** The code each challenge was mailed with, keyed by challenge id. */
  mailedCodes: Map<string, string>;
  /** A fresh cookie per stranger request, as a client dropping the cookie gets. */
  strangerCount: number;
}

const table: FakeChallengeTable = {
  rows: [],
  mailedCodes: new Map(),
  strangerCount: 0,
};

function dateParameter(value: unknown): Date {
  if (!(value instanceof Date)) throw new Error('expected a Date parameter');
  return value;
}

function rowById(id: unknown): StoredChallenge | undefined {
  return table.rows.find((row) => row.id === id);
}

function statsOf(rows: StoredChallenge[]) {
  const times = rows.map((row) => row.createdAt.getTime());
  return {
    count: rows.length,
    oldest: times.length ? new Date(Math.min(...times)) : null,
    latest: times.length ? new Date(Math.max(...times)) : null,
  };
}

function oldestOf(rows: StoredChallenge[]): Date | null {
  const times = rows.map((row) => row.createdAt.getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

/** Answers the advisory lock and the two count queries the service runs. */
function answerQuery(sql: string, parameters: unknown[] = []): unknown[] {
  if (sql.includes('pg_advisory_xact_lock')) return [];
  if (sql.includes('requester_hash')) {
    const [requesterHash, email, purpose, since] = parameters;
    const sinceDate = dateParameter(since);
    return [
      statsOf(
        table.rows.filter(
          (row) =>
            row.requesterHash === requesterHash &&
            row.email === email &&
            row.purpose === purpose &&
            row.createdAt > sinceDate,
        ),
      ),
    ];
  }
  const [email, purpose, since] = parameters;
  const sinceDate = dateParameter(since);
  const addressRows = table.rows.filter(
    (row) =>
      row.email === email &&
      row.purpose === purpose &&
      row.createdAt > sinceDate,
  );
  const sharedRows = addressRows.filter((row) => !row.isTrustedSend);
  const trustedRows = addressRows.filter((row) => row.isTrustedSend);
  return [
    {
      sharedCount: sharedRows.length,
      sharedOldest: oldestOf(sharedRows),
      trustedCount: trustedRows.length,
      trustedOldest: oldestOf(trustedRows),
    },
  ];
}

const managerRepository = {
  findOne: (options: { where: { id: string } }) =>
    Promise.resolve(rowById(options.where.id) ?? null),
  update: (criteria: { id: string }, patch: { failedAttempts: number }) => {
    const row = rowById(criteria.id);
    if (row) row.failedAttempts = patch.failedAttempts;
    return Promise.resolve({ affected: row ? 1 : 0 });
  },
  insert: (
    row: Omit<StoredChallenge, 'consumedAt' | 'supersededAt'>,
  ): Promise<{ identifiers: unknown[] }> => {
    table.rows.push({ ...row, consumedAt: null, supersededAt: null });
    return Promise.resolve({ identifiers: [] });
  },
};

const manager = {
  query: (sql: string, parameters?: unknown[]) =>
    Promise.resolve(answerQuery(sql, parameters)),
  getRepository: () => managerRepository,
};

function supersedeBuilder(): FakeSupersedeBuilder {
  let supersededAt = NOW;
  let parameters: SupersedeParameters | undefined;
  const builder: FakeSupersedeBuilder = {
    update: () => builder,
    set: (patch) => {
      supersededAt = patch.supersededAt;
      return builder;
    },
    where: (_sql, given) => {
      parameters = given;
      return builder;
    },
    execute: () => {
      let affected = 0;
      for (const row of table.rows) {
        if (
          parameters &&
          row.requesterHash === parameters.requesterHash &&
          row.email === parameters.email &&
          row.purpose === parameters.purpose &&
          row.id !== parameters.id &&
          row.consumedAt === null &&
          row.supersededAt === null
        ) {
          row.supersededAt = supersededAt;
          affected += 1;
        }
      }
      return Promise.resolve({ affected });
    },
  };
  return builder;
}

const challengeRepository = {
  update: (criteria: { id: string }, patch: { consumedAt: Date }) => {
    const row = rowById(criteria.id);
    if (!row || row.consumedAt !== null)
      return Promise.resolve({ affected: 0 });
    row.consumedAt = patch.consumedAt;
    return Promise.resolve({ affected: 1 });
  },
  delete: (criteria: { id: string }) => {
    table.rows = table.rows.filter((row) => row.id !== criteria.id);
    return Promise.resolve({ affected: 1 });
  },
  createQueryBuilder: supersedeBuilder,
};

const configValues: Record<string, string> = {
  'email.codeSecret': 'email-code-secret-for-the-lockout-spec',
  'auth.jwtAccessSecret': 'jwt-access-secret-for-the-lockout-spec',
  'app.nodeEnv': 'test',
};

/** The outcome of a verify: `verified` or the refusal reason. */
async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'verified';
  } catch (error) {
    if (error instanceof EmailCodeRefusedError) return error.reason;
    throw error;
  }
}

function wrongCodeFor(challengeId: string): string {
  return table.mailedCodes.get(challengeId) === '000000' ? '000001' : '000000';
}

describe('EmailCodeService lockout resistance (SEC-11)', () => {
  let service: EmailCodeService;

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    table.rows = [];
    table.mailedCodes = new Map();
    table.strangerCount = 0;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        EmailCodeService,
        {
          provide: getRepositoryToken(EmailSignInChallenge),
          useValue: challengeRepository,
        },
        {
          provide: DataSource,
          useValue: {
            transaction: (work: (entityManager: typeof manager) => unknown) =>
              work(manager),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: (path: string) => configValues[path] },
        },
        {
          provide: EmailCodeMailer,
          useValue: {
            sendSignInCode: (input: { challengeId: string; code: string }) => {
              table.mailedCodes.set(input.challengeId, input.code);
              return Promise.resolve({ delivered: true, emailId: 're_spec' });
            },
          },
        },
        {
          provide: UsersService,
          useValue: { findByEmailForSignIn: () => Promise.resolve(null) },
        },
      ],
    }).compile();
    service = moduleRef.get(EmailCodeService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const issueSignIn = (requesterKey: string) =>
    service.issueSignInChallenge({
      rawEmail: ADDRESS,
      requesterKey,
      locale: 'en',
    });

  const verifySignIn = (
    challengeId: string,
    code: string,
    requesterKey: string,
  ) =>
    service.verifyChallenge({
      challengeId,
      code,
      purpose: EmailSignInChallengePurpose.SignIn,
      requesterKey,
    });

  /** A stranger with a fresh cookie asks for a code and spends every wrong try on it. */
  async function strangerBurnsOneCode(): Promise<string> {
    table.strangerCount += 1;
    const strangerCookie = `stranger-${table.strangerCount}`;
    const issued = await issueSignIn(strangerCookie);
    const wrongCode = wrongCodeFor(issued.challengeId);
    for (let attempt = 0; attempt < EMAIL_CODE_MAX_WRONG_ATTEMPTS; attempt++) {
      await outcomeOf(
        verifySignIn(issued.challengeId, wrongCode, strangerCookie),
      );
    }
    return issued.challengeId;
  }

  async function strangerBurnsCodes(count: number): Promise<void> {
    for (let index = 0; index < count; index++) await strangerBurnsOneCode();
  }

  const wrongGuessesOnAddress = () =>
    table.rows
      .filter((row) => row.email === ADDRESS)
      .reduce((total, row) => total + row.failedAttempts, 0);

  interface LockoutScenario {
    scenario: string;
    strangerCodesBefore: number;
    strangerCodesAfter: number;
    expected: string;
  }

  const scenarios: LockoutScenario[] = [
    {
      scenario:
        'stranger burns 17 codes (past the old 50-guess lockout), then the member asks for a code',
      strangerCodesBefore: 17,
      strangerCodesAfter: 0,
      expected: 'verified',
    },
    {
      scenario: 'member asks first, then the stranger burns 29 codes',
      strangerCodesBefore: 0,
      strangerCodesAfter: EMAIL_CODE_ADDRESS_SEND_LIMIT - 1,
      expected: 'verified',
    },
    {
      scenario:
        'stranger burns 29 codes, then the member asks for the last code of the day',
      strangerCodesBefore: EMAIL_CODE_ADDRESS_SEND_LIMIT - 1,
      strangerCodesAfter: 0,
      expected: 'verified',
    },
    {
      scenario: 'stranger burns 15 codes on each side of the member request',
      strangerCodesBefore: 15,
      strangerCodesAfter: EMAIL_CODE_ADDRESS_SEND_LIMIT - 16,
      expected: 'verified',
    },
  ];

  it.each(scenarios)(
    '$scenario: the member code from the member browser answers $expected',
    async ({ strangerCodesBefore, strangerCodesAfter, expected }) => {
      await strangerBurnsCodes(strangerCodesBefore);
      const issued = await issueSignIn(MEMBER_COOKIE);
      await strangerBurnsCodes(strangerCodesAfter);

      const memberCode = table.mailedCodes.get(issued.challengeId) ?? '';
      await expect(
        outcomeOf(verifySignIn(issued.challengeId, memberCode, MEMBER_COOKIE)),
      ).resolves.toBe(expected);
    },
  );

  it('leaves the member challenge untouched when a stranger guesses on its id without the member cookie', async () => {
    const issued = await issueSignIn(MEMBER_COOKIE);
    const wrongCode = wrongCodeFor(issued.challengeId);

    for (let attempt = 0; attempt < 10; attempt++) {
      await expect(
        outcomeOf(verifySignIn(issued.challengeId, wrongCode, 'stranger-x')),
      ).resolves.toBe('code_incorrect');
    }

    expect(rowById(issued.challengeId)?.failedAttempts).toBe(0);
    const memberCode = table.mailedCodes.get(issued.challengeId) ?? '';
    await expect(
      outcomeOf(verifySignIn(issued.challengeId, memberCode, MEMBER_COOKIE)),
    ).resolves.toBe('verified');
  });

  it('caps the wrong guesses one address takes in a day at the send cap times the per-code tries', async () => {
    await strangerBurnsCodes(EMAIL_CODE_ADDRESS_SEND_LIMIT);

    await expect(outcomeOf(issueSignIn('stranger-extra'))).resolves.toBe(
      'too_many_codes',
    );
    // Further guesses on spent codes count nothing.
    const firstChallenge = table.rows[0];
    if (!firstChallenge) throw new Error('expected a stored challenge');
    await expect(
      outcomeOf(
        verifySignIn(
          firstChallenge.id,
          wrongCodeFor(firstChallenge.id),
          'stranger-1',
        ),
      ),
    ).resolves.toBe('code_used_up');

    expect(wrongGuessesOnAddress()).toBe(EMAIL_CODE_ADDRESS_WRONG_GUESS_BOUND);
    expect(EMAIL_CODE_ADDRESS_WRONG_GUESS_BOUND).toBe(
      EMAIL_CODE_ADDRESS_SEND_LIMIT * EMAIL_CODE_MAX_WRONG_ATTEMPTS,
    );
    expect(EMAIL_CODE_ADDRESS_WRONG_GUESS_BOUND).toBe(90);
  });

  // SEC-11: the member's browser verified a code for the address before, so
  // it holds a trusted-requester cookie a stranger cannot produce.
  describe('trusted-requester allowance', () => {
    const issueSignInAs = (
      requesterKey: string,
      trustedRequesterToken: string | undefined,
    ) =>
      service.issueSignInChallenge({
        rawEmail: ADDRESS,
        requesterKey,
        locale: 'en',
        trustedRequesterToken,
      });

    /** One trusted code request from the member, a minute after the last:
     *  `issued` or the refusal reason. */
    async function memberAsksWithTrust(token: string): Promise<string> {
      jest.advanceTimersByTime(EMAIL_CODE_RESEND_COOLDOWN_MS);
      const outcome = await outcomeOf(
        issueSignInAs(`member-${table.rows.length}`, token),
      );
      return outcome === 'verified' ? 'issued' : outcome;
    }

    it('lets the member sign in after strangers spend the whole shared cap', async () => {
      const token = service.mintTrustedRequesterToken(ADDRESS);
      await strangerBurnsCodes(EMAIL_CODE_ADDRESS_SEND_LIMIT);
      await expect(outcomeOf(issueSignIn('stranger-extra'))).resolves.toBe(
        'too_many_codes',
      );

      const issued = await issueSignInAs(MEMBER_COOKIE, token);
      const memberCode = table.mailedCodes.get(issued.challengeId) ?? '';

      expect(rowById(issued.challengeId)?.isTrustedSend).toBe(true);
      await expect(
        outcomeOf(verifySignIn(issued.challengeId, memberCode, MEMBER_COOKIE)),
      ).resolves.toBe('verified');
    });

    it('caps the reserve at its own limit once the shared cap is spent', async () => {
      const token = service.mintTrustedRequesterToken(ADDRESS);
      await strangerBurnsCodes(EMAIL_CODE_ADDRESS_SEND_LIMIT);

      const outcomes: string[] = [];
      for (
        let index = 0;
        index <= EMAIL_CODE_TRUSTED_ADDRESS_SEND_LIMIT;
        index++
      ) {
        outcomes.push(await memberAsksWithTrust(token));
      }

      expect(
        outcomes.slice(0, -1).every((outcome) => outcome === 'issued'),
      ).toBe(true);
      expect(outcomes.at(-1)).toBe('too_many_codes');
      expect(table.rows.filter((row) => row.isTrustedSend)).toHaveLength(
        EMAIL_CODE_TRUSTED_ADDRESS_SEND_LIMIT,
      );
      // The mail one address receives in a day stays bounded.
      expect(table.rows).toHaveLength(
        EMAIL_CODE_ADDRESS_SEND_LIMIT + EMAIL_CODE_TRUSTED_ADDRESS_SEND_LIMIT,
      );
    });

    it('gives a stranger holding a cookie for another address the shared cap alone', async () => {
      const otherAddressToken =
        service.mintTrustedRequesterToken('lee@example.com');
      await strangerBurnsCodes(EMAIL_CODE_ADDRESS_SEND_LIMIT);

      await expect(
        outcomeOf(issueSignInAs('stranger-with-cookie', otherAddressToken)),
      ).resolves.toBe('too_many_codes');
      expect(table.rows.some((row) => row.isTrustedSend)).toBe(false);
    });
  });

  it('keeps the reauth code of a signed-in member working after strangers spend the whole sign-in send cap', async () => {
    await strangerBurnsCodes(EMAIL_CODE_ADDRESS_SEND_LIMIT);

    const issued = await service.issueReauthChallenge({
      userId: MEMBER_ID,
      email: ADDRESS,
      locale: 'en',
    });
    const memberCode = table.mailedCodes.get(issued.challengeId) ?? '';

    await expect(
      outcomeOf(
        service.verifyChallenge({
          challengeId: issued.challengeId,
          code: memberCode,
          purpose: EmailSignInChallengePurpose.Reauth,
          requesterKey: `user:${MEMBER_ID}`,
          userId: MEMBER_ID,
        }),
      ),
    ).resolves.toBe('verified');
  });

  it('still uses up a code after 3 wrong tries, even for the right code afterwards', async () => {
    const issued = await issueSignIn(MEMBER_COOKIE);
    const wrongCode = wrongCodeFor(issued.challengeId);
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < EMAIL_CODE_MAX_WRONG_ATTEMPTS; attempt++) {
      outcomes.push(
        await outcomeOf(
          verifySignIn(issued.challengeId, wrongCode, MEMBER_COOKIE),
        ),
      );
    }

    expect(outcomes).toEqual([
      'code_incorrect',
      'code_incorrect',
      'code_used_up',
    ]);
    const memberCode = table.mailedCodes.get(issued.challengeId) ?? '';
    await expect(
      outcomeOf(verifySignIn(issued.challengeId, memberCode, MEMBER_COOKIE)),
    ).resolves.toBe('code_used_up');
  });

  it('spends a code once: a consumed code answers code_already_used', async () => {
    const issued = await issueSignIn(MEMBER_COOKIE);
    const memberCode = table.mailedCodes.get(issued.challengeId) ?? '';

    await expect(
      outcomeOf(verifySignIn(issued.challengeId, memberCode, MEMBER_COOKIE)),
    ).resolves.toBe('verified');
    await expect(service.consumeChallenge(issued.challengeId)).resolves.toBe(
      true,
    );
    await expect(service.consumeChallenge(issued.challengeId)).resolves.toBe(
      false,
    );
    await expect(
      outcomeOf(verifySignIn(issued.challengeId, memberCode, MEMBER_COOKIE)),
    ).resolves.toBe('code_already_used');
  });
});

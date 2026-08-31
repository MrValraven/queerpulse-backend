import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { CommunityGovernanceLog } from '../communities/entities/community-governance-log.entity';
import { LegalRequest } from '../legal-requests/entities/legal-request.entity';
import {
  LEGAL_REQUEST_OUTCOMES,
  LEGAL_REQUEST_TYPES,
  LegalRequestOutcome,
  LegalRequestType,
} from '../legal-requests/legal-request-vocabulary';
import { Appeal } from '../moderation/entities/appeal.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Report } from '../reports/entities/report.entity';
import { currentPeriod } from './transparency-period';
import { SMALL_COUNT_FLOOR } from './transparency-response';
import { TransparencyService } from './transparency.service';

/** One register row as the fake repository below stores it. Only the columns
 *  the aggregate actually reads. */
interface RegisterRow {
  requestType: LegalRequestType;
  outcome: LegalRequestOutcome;
  receivedOn: string;
  accountsAffected: number;
  accountsNotified: number;
  isUnderGagOrder: boolean;
  voidedAt: Date | null;
  /** Never read by any aggregate. Present so a test can assert it does not
   *  reach the wire. */
  requestingBody: string;
  internalNote: string | null;
}

function registerRow(overrides: Partial<RegisterRow> = {}): RegisterRow {
  return {
    requestType: LegalRequestType.CourtOrder,
    outcome: LegalRequestOutcome.Refused,
    receivedOn: dayInsideCurrentPeriod(),
    accountsAffected: 0,
    accountsNotified: 0,
    isUnderGagOrder: false,
    voidedAt: null,
    requestingBody: 'District Court of Lisbon',
    internalNote: 'Counsel engaged, see the shared drive',
    ...overrides,
  };
}

/** A calendar day the report's CURRENT period covers, whenever the suite runs. */
function dayInsideCurrentPeriod(): string {
  return currentPeriod(new Date()).startsAt.toISOString().slice(0, 10);
}

/** A calendar day before the current period, for the all-time flag. */
function dayBeforeCurrentPeriod(): string {
  const start = currentPeriod(new Date()).startsAt;
  return new Date(start.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * A query builder that actually evaluates the handful of shapes
 * `TransparencyService` builds against `legal_requests`, over an in-memory
 * array. Interpreting the real predicates (rather than returning canned rows)
 * is what makes "a voided record is excluded" and "a gagged record is counted"
 * assertions about the service instead of about the mock.
 */
function legalRequestQueryBuilder(rows: readonly RegisterRow[]) {
  const conditions: { clause: string; params: Record<string, unknown> }[] = [];
  let groupField: 'requestType' | 'outcome' | null = null;
  let isSumSelect = false;

  const matching = (): RegisterRow[] =>
    rows.filter((row) =>
      conditions.every(({ clause, params }) => {
        if (clause.includes('receivedOn >=')) {
          return row.receivedOn >= String(params.startsOn);
        }
        if (clause.includes('receivedOn <')) {
          return row.receivedOn < String(params.endsOn);
        }
        if (clause.includes('voidedAt IS NOT NULL'))
          return row.voidedAt !== null;
        if (clause.includes('voidedAt IS NULL')) return row.voidedAt === null;
        throw new Error(`Unsupported condition in the fake: ${clause}`);
      }),
    );

  const builder = {
    where(clause: string, params: Record<string, unknown> = {}) {
      conditions.push({ clause, params });
      return builder;
    },
    andWhere(clause: string, params: Record<string, unknown> = {}) {
      conditions.push({ clause, params });
      return builder;
    },
    select(expression: string) {
      if (expression.includes('accounts_affected')) isSumSelect = true;
      return builder;
    },
    addSelect() {
      return builder;
    },
    groupBy(expression: string) {
      groupField = expression.endsWith('outcome') ? 'outcome' : 'requestType';
      return builder;
    },
    getRawMany() {
      const field = groupField;
      if (field === null) throw new Error('getRawMany without a groupBy');
      const countByKey = new Map<string, number>();
      for (const row of matching()) {
        countByKey.set(row[field], (countByKey.get(row[field]) ?? 0) + 1);
      }
      return Promise.resolve(
        [...countByKey].map(([groupKey, count]) => ({
          groupKey,
          rowCount: String(count),
        })),
      );
    },
    getRawOne() {
      if (!isSumSelect) throw new Error('getRawOne without a sum select');
      const included = matching();
      return Promise.resolve({
        accountsAffected: String(
          included.reduce((total, row) => total + row.accountsAffected, 0),
        ),
        accountsNotified: String(
          included.reduce((total, row) => total + row.accountsNotified, 0),
        ),
      });
    },
    getCount() {
      return Promise.resolve(matching().length);
    },
  };
  return builder;
}

/** Every other table the report counts, answering empty. */
function emptyQueryBuilder() {
  const builder: Record<string, unknown> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'orderBy',
  ]) {
    builder[method] = () => builder;
  }
  builder.getRawMany = () => Promise.resolve([]);
  builder.getRawOne = () => Promise.resolve(undefined);
  builder.getCount = () => Promise.resolve(0);
  return builder;
}

async function buildService(
  rows: readonly RegisterRow[],
  legalRequestRepositoryOverride?: { createQueryBuilder: jest.Mock },
): Promise<TransparencyService> {
  const emptyRepository = { createQueryBuilder: () => emptyQueryBuilder() };
  const legalRequestRepository = legalRequestRepositoryOverride ?? {
    createQueryBuilder: jest.fn(() => legalRequestQueryBuilder(rows)),
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      TransparencyService,
      { provide: getRepositoryToken(Report), useValue: emptyRepository },
      { provide: getRepositoryToken(ModAuditLog), useValue: emptyRepository },
      { provide: getRepositoryToken(Appeal), useValue: emptyRepository },
      {
        provide: getRepositoryToken(CommunityGovernanceLog),
        useValue: emptyRepository,
      },
      {
        provide: getRepositoryToken(LegalRequest),
        useValue: legalRequestRepository,
      },
    ],
  }).compile();
  return module.get(TransparencyService);
}

describe('TransparencyService legal-request aggregate', () => {
  it('publishes an explicit zero, and the section itself, on an empty register', async () => {
    const service = await buildService([]);

    const report = await service.getReport('current');
    const legalRequests = report.legalRequests;

    // The whole point of the disclosure: an absent section reads as an
    // omission, and a withheld zero reads as a cover-up.
    expect(legalRequests).toBeDefined();
    expect(legalRequests.hasEverReceivedRequest).toBe(false);
    expect(legalRequests.received).toEqual({ value: 0, isSuppressed: false });
    expect(legalRequests.accountsAffected).toEqual({
      value: 0,
      isSuppressed: false,
    });
    expect(legalRequests.accountsNotified).toEqual({
      value: 0,
      isSuppressed: false,
    });
    expect(legalRequests.recordsVoided).toEqual({
      value: 0,
      isSuppressed: false,
    });
    expect(legalRequests.byType.map((row) => row.count.value)).toEqual(
      LEGAL_REQUEST_TYPES.map(() => 0),
    );
    expect(legalRequests.byOutcome.map((row) => row.count.value)).toEqual(
      LEGAL_REQUEST_OUTCOMES.map(() => 0),
    );
  });

  it('never publishes a zero it did not count: a failing query rejects the report', async () => {
    // Fails where a real database failure surfaces: when the query runs.
    const failingRepository = {
      createQueryBuilder: jest.fn(() => {
        const failing: Record<string, unknown> = {};
        for (const method of [
          'select',
          'addSelect',
          'where',
          'andWhere',
          'groupBy',
        ]) {
          failing[method] = () => failing;
        }
        const reject = () => Promise.reject(new Error('register unavailable'));
        failing.getRawMany = reject;
        failing.getRawOne = reject;
        failing.getCount = reject;
        return failing;
      }),
    };
    const service = await buildService([], failingRepository);

    await expect(service.getReport('current')).rejects.toThrow(
      'register unavailable',
    );
  });

  it('counts a gag-ordered demand in the totals like any other, and marks none of them', async () => {
    const rows = [
      ...Array.from({ length: SMALL_COUNT_FLOOR }, () =>
        registerRow({
          isUnderGagOrder: true,
          requestType: LegalRequestType.EmergencyDisclosureRequest,
          outcome: LegalRequestOutcome.CompliedInFull,
        }),
      ),
    ];
    const service = await buildService(rows);

    const { legalRequests } = await service.getReport('current');

    expect(legalRequests.received).toEqual({
      value: SMALL_COUNT_FLOOR,
      isSuppressed: false,
    });
    expect(
      legalRequests.byType.find(
        (row) => row.key === LegalRequestType.EmergencyDisclosureRequest,
      )?.count.value,
    ).toBe(SMALL_COUNT_FLOOR);
    // Counting is not describing: nothing in the section says which rows are
    // gagged, so a gagged demand and an ordinary one publish identically.
    expect(JSON.stringify(legalRequests)).not.toContain('gag');
  });

  it('drops voided records from every figure and publishes them as their own count', async () => {
    const rows = [
      ...Array.from({ length: SMALL_COUNT_FLOOR }, () =>
        registerRow({ accountsAffected: 2, accountsNotified: 1 }),
      ),
      ...Array.from({ length: SMALL_COUNT_FLOOR }, () =>
        registerRow({
          accountsAffected: 100,
          accountsNotified: 100,
          voidedAt: new Date(),
        }),
      ),
    ];
    const service = await buildService(rows);

    const { legalRequests } = await service.getReport('current');

    expect(legalRequests.received.value).toBe(SMALL_COUNT_FLOOR);
    expect(legalRequests.accountsAffected.value).toBe(2 * SMALL_COUNT_FLOOR);
    expect(legalRequests.accountsNotified.value).toBe(SMALL_COUNT_FLOOR);
    // Struck, never removed: emptying the register is itself a number.
    expect(legalRequests.recordsVoided.value).toBe(SMALL_COUNT_FLOOR);
  });

  it('says the register has been used before even when this period is empty', async () => {
    const service = await buildService([
      registerRow({ receivedOn: dayBeforeCurrentPeriod() }),
    ]);

    const { legalRequests } = await service.getReport('current');

    expect(legalRequests.received).toEqual({ value: 0, isSuppressed: false });
    expect(legalRequests.hasEverReceivedRequest).toBe(true);
  });

  it('withholds a count below the floor, exactly as the rest of the report does', async () => {
    const rows = Array.from({ length: SMALL_COUNT_FLOOR - 1 }, () =>
      registerRow({ accountsAffected: 1, accountsNotified: 0 }),
    );
    const service = await buildService(rows);

    const { legalRequests } = await service.getReport('current');

    expect(legalRequests.received).toEqual({ value: null, isSuppressed: true });
    expect(legalRequests.accountsAffected).toEqual({
      value: null,
      isSuppressed: true,
    });
  });

  it('exposes no requesting body, no internal note and no per-request row', async () => {
    const rows = Array.from({ length: SMALL_COUNT_FLOOR }, () =>
      registerRow({
        requestingBody: 'Polícia Judiciária',
        internalNote: 'Counsel engaged, see the shared drive',
      }),
    );
    const service = await buildService(rows);

    const { legalRequests } = await service.getReport('current');
    const serialised = JSON.stringify(legalRequests);

    expect(serialised).not.toContain('Polícia Judiciária');
    expect(serialised).not.toContain('Counsel engaged');
    expect(serialised).not.toContain('requestingBody');
    expect(serialised).not.toContain('jurisdiction');
    expect(serialised).not.toContain('internalNote');
    expect(serialised).not.toContain('voidReason');
    expect(serialised).not.toContain('dataDisclosed');
    // The published shape is a fixed set of counts and one boolean. Anything
    // added to it later has to be added to this list deliberately.
    expect(Object.keys(legalRequests).sort()).toEqual([
      'accountsAffected',
      'accountsNotified',
      'byOutcome',
      'byType',
      'hasEverReceivedRequest',
      'received',
      'recordsVoided',
    ]);
    for (const row of [...legalRequests.byType, ...legalRequests.byOutcome]) {
      expect(Object.keys(row).sort()).toEqual(['count', 'key']);
    }
  });
});

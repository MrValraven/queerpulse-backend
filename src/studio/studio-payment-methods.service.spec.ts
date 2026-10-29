import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { StudioPaymentMethodKind } from './entities/studio-payment-method.entity';
import {
  PAYMENT_METHODS_LOCK_SQL,
  PERSONA_HAS_ITEMS_FOR_SALE_SQL,
} from './studio-payment-method-lock';
import {
  PERSONA_KIND_SQL,
  PERSONA_PAYMENT_METHODS_SQL,
  StudioPaymentMethodsService,
} from './studio-payment-methods.service';
import { StudioOwnershipService } from './studio-ownership.service';

const USER_ID = '7e000000-0000-4000-8000-000000000001';
const PERSONA_ID = '7e000000-0000-4000-8000-000000000002';

const LINK_ROW = {
  kind: StudioPaymentMethodKind.Link,
  value: 'https://example.com/pay',
};

interface StoredRow {
  id: string;
  kind: string;
  label: string | null;
  value: string;
  note: string | null;
  position: number;
  updated_at: Date;
}

const storedRow = (overrides: Partial<StoredRow>): StoredRow => ({
  id: '7e000000-0000-4000-8000-0000000000a1',
  kind: 'link',
  label: null,
  value: 'https://example.com/pay',
  note: null,
  position: 0,
  updated_at: new Date('2026-10-20T10:00:00.000Z'),
  ...overrides,
});

async function errorOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (caught) {
    return caught as HttpException;
  }
  throw new Error('expected the call to reject');
}

describe('StudioPaymentMethodsService', () => {
  let ownership: { isPersonaMember: jest.Mock };
  let queryLog: string[];
  let queryParameters: Map<string, unknown[]>;
  let storedRows: StoredRow[];
  let personaKind: string;
  let hasItemsForSale: boolean;
  let runQuery: jest.Mock;
  let dataSource: { query: jest.Mock; transaction: jest.Mock };
  let service: StudioPaymentMethodsService;

  beforeEach(() => {
    ownership = { isPersonaMember: jest.fn().mockResolvedValue(true) };
    queryLog = [];
    queryParameters = new Map();
    storedRows = [];
    personaKind = 'musician';
    hasItemsForSale = false;
    runQuery = jest.fn((sql: string, parameters?: unknown[]) => {
      queryLog.push(sql.split(' ')[0] ?? '');
      queryParameters.set(sql, parameters ?? []);
      if (sql === PERSONA_PAYMENT_METHODS_SQL) {
        return Promise.resolve(storedRows);
      }
      if (sql === PERSONA_HAS_ITEMS_FOR_SALE_SQL) {
        return Promise.resolve([{ has_items_for_sale: hasItemsForSale }]);
      }
      if (sql === PERSONA_KIND_SQL) {
        return Promise.resolve([{ kind: personaKind }]);
      }
      return Promise.resolve([]);
    });
    const manager = { query: runQuery } as unknown as EntityManager;
    dataSource = {
      query: runQuery,
      transaction: jest.fn((work: (entityManager: EntityManager) => unknown) =>
        Promise.resolve(work(manager)),
      ),
    };
    service = new StudioPaymentMethodsService(
      dataSource as unknown as DataSource,
      ownership as unknown as StudioOwnershipService,
    );
  });

  const statementsStartingWith = (prefix: string): string[] =>
    runQuery.mock.calls
      .map((call: unknown[]) => call[0] as string)
      .filter((sql) => sql.startsWith(prefix));

  it('answers studio_persona_not_found to a caller outside the persona before any read', async () => {
    ownership.isPersonaMember.mockResolvedValue(false);
    await expect(service.getMethods(USER_ID, PERSONA_ID)).rejects.toMatchObject(
      {
        response: { code: 'studio_persona_not_found', statusCode: 404 },
      },
    );
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('answers studio_persona_not_found to a writer outside the persona before any read', async () => {
    ownership.isPersonaMember.mockResolvedValue(false);
    await expect(
      service.replaceMethods(USER_ID, PERSONA_ID, { methods: [LINK_ROW] }),
    ).rejects.toMatchObject({
      response: { code: 'studio_persona_not_found', statusCode: 404 },
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('lists the methods by position with hasItemsForSale and the latest update', async () => {
    hasItemsForSale = true;
    storedRows = [
      storedRow({ id: 'a', position: 0 }),
      storedRow({
        id: 'b',
        kind: 'mbway',
        value: '912345678',
        label: 'Phone',
        note: 'Mornings',
        position: 1,
        updated_at: new Date('2026-10-22T08:30:00.000Z'),
      }),
    ];
    const result = await service.getMethods(USER_ID, PERSONA_ID);
    expect(result).toEqual({
      methods: [
        {
          id: 'a',
          kind: 'link',
          label: null,
          value: 'https://example.com/pay',
          note: null,
          position: 0,
        },
        {
          id: 'b',
          kind: 'mbway',
          label: 'Phone',
          value: '912345678',
          note: 'Mornings',
          position: 1,
        },
      ],
      hasItemsForSale: true,
      updatedAt: '2026-10-22T08:30:00.000Z',
    });
    expect(queryParameters.get(PERSONA_PAYMENT_METHODS_SQL)).toEqual([
      PERSONA_ID,
    ]);
    expect(PERSONA_PAYMENT_METHODS_SQL).toContain(
      'ORDER BY "method"."position" ASC',
    );
  });

  it('answers an empty list with a null update time', async () => {
    const result = await service.getMethods(USER_ID, PERSONA_ID);
    expect(result).toEqual({
      methods: [],
      hasItemsForSale: false,
      updatedAt: null,
    });
  });

  it('refuses a persona of another kind on the write with studio_persona_kind_not_allowed', async () => {
    personaKind = 'member';
    const error = await errorOf(
      service.replaceMethods(USER_ID, PERSONA_ID, { methods: [LINK_ROW] }),
    );
    expect(error.getResponse()).toMatchObject({
      code: 'studio_persona_kind_not_allowed',
      statusCode: 403,
    });
    expect(statementsStartingWith('DELETE')).toEqual([]);
  });

  it('answers nine rows with studio_payment_methods_limit before reading any value', async () => {
    const invalidRows = Array.from({ length: 9 }, () => ({
      kind: StudioPaymentMethodKind.Iban,
      value: 'PT50 0000 BAD',
    }));
    const error = await errorOf(
      service.replaceMethods(USER_ID, PERSONA_ID, { methods: invalidRows }),
    );
    expect(error.getResponse()).toMatchObject({
      code: 'studio_payment_methods_limit',
      statusCode: 400,
    });
    expect(queryParameters.has(PAYMENT_METHODS_LOCK_SQL)).toBe(false);
  });

  it('answers an invalid IBAN with its code and index and never echoes the value', async () => {
    const error = await errorOf(
      service.replaceMethods(USER_ID, PERSONA_ID, {
        methods: [
          LINK_ROW,
          { kind: StudioPaymentMethodKind.Iban, value: 'PT50 0000 BAD' },
        ],
      }),
    );
    expect(error.getResponse()).toEqual({
      index: 1,
      statusCode: 400,
      code: 'studio_payment_iban_invalid',
      message: expect.any(String) as string,
    });
    expect(JSON.stringify(error.getResponse())).not.toContain('PT50');
  });

  it('answers an invalid link and an invalid MB WAY number with their codes and indexes', async () => {
    const linkError = await errorOf(
      service.replaceMethods(USER_ID, PERSONA_ID, {
        methods: [{ kind: StudioPaymentMethodKind.Link, value: 'http://x.pt' }],
      }),
    );
    expect(linkError.getResponse()).toMatchObject({
      index: 0,
      code: 'studio_payment_link_invalid',
      statusCode: 400,
    });
    const mbwayError = await errorOf(
      service.replaceMethods(USER_ID, PERSONA_ID, {
        methods: [
          LINK_ROW,
          LINK_ROW,
          { kind: StudioPaymentMethodKind.Mbway, value: '12345' },
        ],
      }),
    );
    expect(mbwayError.getResponse()).toMatchObject({
      index: 2,
      code: 'studio_payment_mbway_invalid',
      statusCode: 400,
    });
  });

  it('stores the canonical values, plain-text labels and notes, and the array order as position', async () => {
    await service.replaceMethods(USER_ID, PERSONA_ID, {
      methods: [
        {
          kind: StudioPaymentMethodKind.Mbway,
          value: '+351 912 345 678',
          label: '<b>Shop</b>',
          note: '',
        },
        {
          kind: StudioPaymentMethodKind.Iban,
          value: 'pt50 0002 0123 1234 5678 9015 4',
          label: null,
          note: '<i>Weekdays</i>',
        },
      ],
    });
    const insertSql = statementsStartingWith('INSERT')[0] ?? '';
    expect(queryParameters.get(insertSql)).toEqual([
      PERSONA_ID,
      'mbway',
      'Shop',
      '912345678',
      null,
      0,
      'iban',
      null,
      'PT50000201231234567890154',
      'Weekdays',
      1,
    ]);
  });

  it('takes the payment-methods lock before it checks for items for sale', async () => {
    await service.replaceMethods(USER_ID, PERSONA_ID, {
      methods: [LINK_ROW],
    });
    const statements = runQuery.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    const lockIndex = statements.indexOf(PAYMENT_METHODS_LOCK_SQL);
    const itemsIndex = statements.indexOf(PERSONA_HAS_ITEMS_FOR_SALE_SQL);
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(itemsIndex).toBeGreaterThan(lockIndex);
    expect(queryParameters.get(PAYMENT_METHODS_LOCK_SQL)).toEqual([PERSONA_ID]);
  });

  it('refuses to empty the list while anything is for sale', async () => {
    hasItemsForSale = true;
    storedRows = [storedRow({})];
    const error = await errorOf(
      service.replaceMethods(USER_ID, PERSONA_ID, { methods: [] }),
    );
    expect(error.getResponse()).toMatchObject({
      code: 'studio_payment_methods_needed_for_sale',
      statusCode: 409,
    });
    expect(statementsStartingWith('DELETE')).toEqual([]);
  });

  it('empties the list when nothing is for sale', async () => {
    storedRows = [storedRow({})];
    await service.replaceMethods(USER_ID, PERSONA_ID, { methods: [] });
    expect(statementsStartingWith('DELETE')).toHaveLength(1);
    expect(statementsStartingWith('INSERT')).toEqual([]);
  });

  it('writes nothing and keeps the ids when the list is unchanged', async () => {
    storedRows = [
      storedRow({ id: 'keep-a', position: 0 }),
      storedRow({
        id: 'keep-b',
        kind: 'mbway',
        value: '912345678',
        label: 'Phone',
        position: 1,
      }),
    ];
    const result = await service.replaceMethods(USER_ID, PERSONA_ID, {
      methods: [
        LINK_ROW,
        {
          kind: StudioPaymentMethodKind.Mbway,
          value: '912 345 678',
          label: 'Phone',
        },
      ],
    });
    expect(statementsStartingWith('DELETE')).toEqual([]);
    expect(statementsStartingWith('INSERT')).toEqual([]);
    expect(result.methods.map((method) => method.id)).toEqual([
      'keep-a',
      'keep-b',
    ]);
  });

  it('replaces the rows in one transaction', async () => {
    storedRows = [storedRow({ id: 'old', value: 'https://old.example.com' })];
    await service.replaceMethods(USER_ID, PERSONA_ID, {
      methods: [LINK_ROW],
    });
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    const writes = runQuery.mock.calls
      .map((call: unknown[]) => call[0] as string)
      .filter((sql) => sql.startsWith('DELETE') || sql.startsWith('INSERT'))
      .map((sql) => sql.split(' ')[0]);
    expect(writes).toEqual(['DELETE', 'INSERT']);
    expect(statementsStartingWith('INSERT')).toHaveLength(1);
  });
});

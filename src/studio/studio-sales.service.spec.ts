import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { DeclineStudioPurchaseDto } from './dto/decline-studio-purchase.dto';
import {
  StudioPurchaseItemKind,
  StudioPurchaseStatus,
} from './entities/studio-purchase.entity';
import { decodeStudioCursor } from './studio-cursor';
import { StudioOwnershipService } from './studio-ownership.service';
import { PurchaseRow } from './studio-purchase-rows';
import {
  STUDIO_PURCHASE_CONFIRMED,
  STUDIO_PURCHASE_DECLINED,
} from './studio-purchase.events';
import {
  CONFIRM_PURCHASE_SQL,
  DECLINE_PURCHASE_SQL,
  LOCK_PURCHASE_SQL,
  PENDING_COUNT_SQL,
  SALES_SQL,
  SALES_TOTALS_SQL,
  StudioSalesService,
  TO_CONFIRM_SQL,
} from './studio-sales.service';

const USER_ID = 'e7000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'e7000000-0000-4000-8000-000000000002';
const OTHER_PERSONA_ID = 'e7000000-0000-4000-8000-000000000003';
const PURCHASE_ID = 'e7000000-0000-4000-8000-000000000004';
const BUYER_ID = 'e7000000-0000-4000-8000-000000000005';
const RELEASE_ID = 'e7000000-0000-4000-8000-000000000006';
const SECOND_PURCHASE_ID = 'e7000000-0000-4000-8000-000000000007';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const purchaseRow = (overrides: Partial<PurchaseRow> = {}): PurchaseRow => ({
  id: PURCHASE_ID,
  buyer_user_id: BUYER_ID,
  subprofile_id: PERSONA_ID,
  artist_name: 'Harbour Lights',
  item_kind: StudioPurchaseItemKind.Release,
  release_id: RELEASE_ID,
  track_id: null,
  item_title: 'Low tide',
  amount_cents: 800,
  reference_code: 'QPAB23',
  payer_name: 'Rui',
  status: StudioPurchaseStatus.Pending,
  decline_reason: null,
  decline_note: null,
  is_on_wall: false,
  is_shown_as_persona: false,
  shown_as_subprofile_id: null,
  created_at: new Date('2026-10-20T09:00:00.000Z'),
  decided_at: null,
  live_release_id: RELEASE_ID,
  live_release_title: 'Low tide',
  live_release_type: 'album',
  live_cover_key: null,
  live_track_title: null,
  live_persona_name: 'Harbour Lights',
  live_persona_handle: 'harbour-lights',
  is_persona_linkable: true,
  ...overrides,
});

const buyerProfile: Partial<Profile> = {
  userId: BUYER_ID,
  slug: 'rui-m',
  firstName: 'Rui',
  lastName: 'Matos',
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
};

const declineBody = (
  overrides: Partial<DeclineStudioPurchaseDto> = {},
): DeclineStudioPurchaseDto =>
  Object.assign(new DeclineStudioPurchaseDto(), {
    reason: 'amount_different',
    ...overrides,
  });

describe('StudioSalesService', () => {
  let query: jest.Mock;
  let managerQuery: jest.Mock;
  let transaction: jest.Mock;
  let isPersonaMember: jest.Mock;
  let findProfiles: jest.Mock;
  let emit: jest.Mock;
  let lockedRow: { id: string; subprofile_id: string | null; status: string };
  let order: string[];
  let service: StudioSalesService;

  beforeEach(() => {
    order = [];
    lockedRow = {
      id: PURCHASE_ID,
      subprofile_id: PERSONA_ID,
      status: 'pending',
    };
    query = jest.fn().mockResolvedValue([]);
    managerQuery = jest.fn((sql: string) =>
      Promise.resolve(sql === LOCK_PURCHASE_SQL ? [lockedRow] : []),
    );
    transaction = jest.fn(
      async (work: (manager: EntityManager) => Promise<unknown>) => {
        const result = await work({
          query: managerQuery,
        } as unknown as EntityManager);
        order.push('committed');
        return result;
      },
    );
    isPersonaMember = jest.fn().mockResolvedValue(true);
    findProfiles = jest.fn().mockResolvedValue([buyerProfile]);
    emit = jest.fn(() => {
      order.push('emitted');
      return true;
    });
    service = new StudioSalesService(
      { query, transaction } as unknown as DataSource,
      { isPersonaMember } as unknown as StudioOwnershipService,
      { find: findProfiles } as unknown as Repository<Profile>,
      { emit } as unknown as EventEmitter2,
    );
  });

  it('answers studio_persona_not_found before any read for every owner method', async () => {
    isPersonaMember.mockResolvedValue(false);
    const codes = await Promise.all([
      codeOf(service.listToConfirm(USER_ID, PERSONA_ID, undefined)),
      codeOf(service.listSales(USER_ID, PERSONA_ID, undefined)),
      codeOf(service.totals(USER_ID, PERSONA_ID)),
      codeOf(service.confirm(USER_ID, PERSONA_ID, PURCHASE_ID)),
      codeOf(service.decline(USER_ID, PERSONA_ID, PURCHASE_ID, declineBody())),
    ]);
    expect(codes).toEqual(Array(5).fill('studio_persona_not_found'));
    expect(isPersonaMember.mock.calls).toEqual(
      Array(5).fill([USER_ID, PERSONA_ID]),
    );
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(managerQuery).not.toHaveBeenCalled();
    expect(findProfiles).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('lists claims oldest first with the buyer account and Deleted account for an erased buyer', async () => {
    query.mockResolvedValueOnce([
      purchaseRow(),
      purchaseRow({
        id: SECOND_PURCHASE_ID,
        buyer_user_id: null,
        payer_name: null,
        created_at: new Date('2026-10-21T09:00:00.000Z'),
      }),
    ]);

    const page = await service.listToConfirm(USER_ID, PERSONA_ID, undefined);

    expect(query).toHaveBeenCalledWith(TO_CONFIRM_SQL, [
      PERSONA_ID,
      null,
      null,
      31,
    ]);
    expect(TO_CONFIRM_SQL).toContain(`"purchase"."status" = 'pending'`);
    expect(TO_CONFIRM_SQL).toContain(
      'ORDER BY "purchase"."created_at" ASC, "purchase"."id" ASC',
    );
    expect(TO_CONFIRM_SQL).toContain(
      '("purchase"."created_at", "purchase"."id") > ($2::timestamptz, $3::uuid)',
    );
    expect(findProfiles).toHaveBeenCalledTimes(1);
    expect(page).toEqual({
      items: [
        {
          id: PURCHASE_ID,
          status: 'pending',
          item: {
            kind: 'release',
            title: 'Low tide',
            releaseId: RELEASE_ID,
            trackId: null,
            releaseType: 'album',
            coverUrl: null,
            isAvailable: true,
          },
          amountCents: 800,
          referenceCode: 'QPAB23',
          payerName: 'Rui',
          buyer: { slug: 'rui-m', displayName: 'Rui Matos', avatarUrl: null },
          createdAt: '2026-10-20T09:00:00.000Z',
          decidedAt: null,
        },
        expect.objectContaining({
          id: SECOND_PURCHASE_ID,
          payerName: null,
          buyer: null,
          createdAt: '2026-10-21T09:00:00.000Z',
        }),
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    expect(JSON.stringify(page)).not.toContain('buyer_user_id');
    expect(JSON.stringify(page)).not.toContain(BUYER_ID);
  });

  it('lists sales newest first by decision time', async () => {
    const decidedRows = Array.from({ length: 31 }, (_unused, index) =>
      purchaseRow({
        id: `e7100000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        status: StudioPurchaseStatus.Confirmed,
        decided_at: new Date(Date.UTC(2026, 9, 27, 12, 0, 0) - index * 60000),
      }),
    );
    query.mockResolvedValueOnce(decidedRows);

    const page = await service.listSales(USER_ID, PERSONA_ID, undefined);

    expect(query).toHaveBeenCalledWith(SALES_SQL, [PERSONA_ID, null, null, 31]);
    expect(SALES_SQL).toContain(`"purchase"."status" = 'confirmed'`);
    expect(SALES_SQL).toContain(
      'ORDER BY "purchase"."decided_at" DESC, "purchase"."id" DESC',
    );
    expect(SALES_SQL).toContain(
      '("purchase"."decided_at", "purchase"."id") < ($2::timestamptz, $3::uuid)',
    );
    expect(page.items.map((item) => [item.status, item.decidedAt])).toEqual(
      decidedRows
        .slice(0, 30)
        .map((row) => ['confirmed', row.decided_at?.toISOString()]),
    );
    expect(page.pageInfo.hasMore).toBe(true);
    const lastPageRow = decidedRows[29];
    expect(decodeStudioCursor(page.pageInfo.nextCursor ?? undefined)).toEqual({
      publishedAt: lastPageRow?.decided_at,
      id: lastPageRow?.id,
    });
  });

  it('passes the decoded cursor to the next page', async () => {
    const firstPage = Array.from({ length: 31 }, (_unused, index) =>
      purchaseRow({
        id: `e7200000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        created_at: new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + index * 60000),
      }),
    );
    query.mockResolvedValueOnce(firstPage);
    const page = await service.listToConfirm(USER_ID, PERSONA_ID, undefined);

    await service.listToConfirm(
      USER_ID,
      PERSONA_ID,
      page.pageInfo.nextCursor ?? undefined,
    );

    const lastPageRow = firstPage[29];
    expect(query).toHaveBeenLastCalledWith(TO_CONFIRM_SQL, [
      PERSONA_ID,
      lastPageRow?.created_at,
      lastPageRow?.id,
      31,
    ]);
  });

  it('sums the last 28 days and all time from bigint strings', async () => {
    query.mockResolvedValueOnce([
      { last_amount: '1500', last_count: 2, all_amount: '4200', all_count: 5 },
    ]);
    await expect(service.totals(USER_ID, PERSONA_ID)).resolves.toEqual({
      last28Days: { amountCents: 1500, count: 2 },
      allTime: { amountCents: 4200, count: 5 },
    });
    expect(SALES_TOTALS_SQL).toContain(
      `"decided_at" >= now() - interval '28 days'`,
    );
    expect(SALES_TOTALS_SQL).toContain(`"purchase"."status" = 'confirmed'`);
    expect(query).toHaveBeenCalledWith(SALES_TOTALS_SQL, [PERSONA_ID]);
  });

  it('counts pending claims on every persona the caller is a member of, per persona, counts above zero only', async () => {
    query.mockResolvedValueOnce([
      { subprofile_id: PERSONA_ID, count: 3 },
      { subprofile_id: OTHER_PERSONA_ID, count: '0' },
      { subprofile_id: 'e7000000-0000-4000-8000-000000000009', count: '2' },
    ]);

    await expect(service.pendingCount(USER_ID)).resolves.toEqual({
      count: 5,
      byPersona: [
        { subprofileId: PERSONA_ID, count: 3 },
        { subprofileId: 'e7000000-0000-4000-8000-000000000009', count: 2 },
      ],
    });
    expect(query).toHaveBeenCalledWith(PENDING_COUNT_SQL, [USER_ID]);
    expect(PENDING_COUNT_SQL).toContain('"subprofile_members"');
    expect(PENDING_COUNT_SQL).toContain(`"purchase"."status" = 'pending'`);
    expect(isPersonaMember).not.toHaveBeenCalled();
  });

  it('answers a caller with no pending claims with zero and no personas', async () => {
    await expect(service.pendingCount(USER_ID)).resolves.toEqual({
      count: 0,
      byPersona: [],
    });
  });

  it('confirms under the row lock, stamps the decider and emits after the transaction commits', async () => {
    await service.confirm(USER_ID, PERSONA_ID, PURCHASE_ID);

    expect(managerQuery.mock.calls).toEqual([
      [LOCK_PURCHASE_SQL, [PURCHASE_ID]],
      [CONFIRM_PURCHASE_SQL, [PURCHASE_ID, USER_ID]],
    ]);
    expect(LOCK_PURCHASE_SQL).toBe(
      'SELECT "id", "subprofile_id", "status" FROM "studio_purchases" WHERE "id" = $1 FOR UPDATE',
    );
    expect(CONFIRM_PURCHASE_SQL).toContain(`"status" = 'confirmed'`);
    expect(CONFIRM_PURCHASE_SQL).toContain('"decided_at" = now()');
    expect(CONFIRM_PURCHASE_SQL).toContain('"decided_by_user_id" = $2::uuid');
    expect(CONFIRM_PURCHASE_SQL).toContain('"updated_at" = now()');
    expect(order).toEqual(['committed', 'emitted']);
    expect(emit).toHaveBeenCalledWith(STUDIO_PURCHASE_CONFIRMED, {
      purchaseId: PURCHASE_ID,
    });
  });

  it('answers studio_purchase_not_found for a purchase of another persona and studio_purchase_not_pending for a decided one', async () => {
    lockedRow.subprofile_id = OTHER_PERSONA_ID;
    expect(
      await codeOf(service.confirm(USER_ID, PERSONA_ID, PURCHASE_ID)),
    ).toBe('studio_purchase_not_found');

    lockedRow.subprofile_id = null;
    expect(
      await codeOf(
        service.decline(USER_ID, PERSONA_ID, PURCHASE_ID, declineBody()),
      ),
    ).toBe('studio_purchase_not_found');

    managerQuery.mockImplementationOnce(() => Promise.resolve([]));
    expect(
      await codeOf(service.confirm(USER_ID, PERSONA_ID, PURCHASE_ID)),
    ).toBe('studio_purchase_not_found');

    lockedRow.subprofile_id = PERSONA_ID;
    lockedRow.status = 'confirmed';
    expect(
      await codeOf(service.confirm(USER_ID, PERSONA_ID, PURCHASE_ID)),
    ).toBe('studio_purchase_not_pending');
    lockedRow.status = 'cancelled';
    expect(
      await codeOf(
        service.decline(USER_ID, PERSONA_ID, PURCHASE_ID, declineBody()),
      ),
    ).toBe('studio_purchase_not_pending');

    const writes = managerQuery.mock.calls.filter(
      ([sql]) => sql !== LOCK_PURCHASE_SQL,
    );
    expect(writes).toEqual([]);
  });

  it('stores the decline reason and a plain-text note, and null for an empty note', async () => {
    await service.decline(
      USER_ID,
      PERSONA_ID,
      PURCHASE_ID,
      declineBody({ reason: 'other', note: '<b>Sent to the wrong IBAN</b>' }),
    );
    await service.decline(
      USER_ID,
      PERSONA_ID,
      PURCHASE_ID,
      declineBody({ reason: 'payment_not_found', note: '' }),
    );
    await service.decline(USER_ID, PERSONA_ID, PURCHASE_ID, declineBody());

    expect(
      managerQuery.mock.calls.filter(([sql]) => sql === DECLINE_PURCHASE_SQL),
    ).toEqual([
      [
        DECLINE_PURCHASE_SQL,
        [PURCHASE_ID, USER_ID, 'other', 'Sent to the wrong IBAN'],
      ],
      [DECLINE_PURCHASE_SQL, [PURCHASE_ID, USER_ID, 'payment_not_found', null]],
      [DECLINE_PURCHASE_SQL, [PURCHASE_ID, USER_ID, 'amount_different', null]],
    ]);
    expect(DECLINE_PURCHASE_SQL).toContain(`"status" = 'declined'`);
    expect(DECLINE_PURCHASE_SQL).toContain('"decided_at" = now()');
    expect(DECLINE_PURCHASE_SQL).toContain('"decided_by_user_id" = $2::uuid');
    expect(DECLINE_PURCHASE_SQL).toContain('"decline_reason" =');
    expect(DECLINE_PURCHASE_SQL).toContain('"decline_note" = $4');
    expect(emit.mock.calls).toEqual(
      Array(3).fill([STUDIO_PURCHASE_DECLINED, { purchaseId: PURCHASE_ID }]),
    );
  });

  it('emits nothing when the decision fails', async () => {
    lockedRow.status = 'expired';
    await codeOf(service.confirm(USER_ID, PERSONA_ID, PURCHASE_ID));
    await codeOf(
      service.decline(USER_ID, PERSONA_ID, PURCHASE_ID, declineBody()),
    );

    lockedRow.status = 'pending';
    managerQuery.mockImplementation((sql: string) =>
      sql === LOCK_PURCHASE_SQL
        ? Promise.resolve([lockedRow])
        : Promise.reject(new Error('connection reset')),
    );
    await expect(
      service.confirm(USER_ID, PERSONA_ID, PURCHASE_ID),
    ).rejects.toThrow('connection reset');

    expect(order).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });
});

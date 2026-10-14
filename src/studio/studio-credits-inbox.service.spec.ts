import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import {
  StudioPersonaCredit,
  StudioPersonaCreditState,
} from './entities/studio-persona-credit.entity';
import { STUDIO_CREDIT_ACCEPTED } from './studio-persona-credit.events';
import { TRACK_RELEASE_PERSONA_SQL } from './studio-persona-credits.service';
import {
  INBOX_ACCEPTED_SQL,
  INBOX_CREDIT_VISIBLE_SQL,
  INBOX_PENDING_COUNT_SQL,
  INBOX_REQUESTS_SQL,
  INBOX_ROW_BY_ID_SQL,
  LOCK_TRACK_RELEASE_SQL,
  StudioCreditsInboxService,
} from './studio-credits-inbox.service';

const VIEWER_ID = 'f7000000-0000-4000-8000-000000000001';
const CREDIT_ID = 'f7000000-0000-4000-8000-000000000002';
const CREDITED_PERSONA = 'f7000000-0000-4000-8000-000000000003';
const RELEASE_PERSONA = 'f7000000-0000-4000-8000-000000000004';
const TRACK_ID = 'f7000000-0000-4000-8000-000000000005';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const inboxRow = (status: 'pending' | 'accepted') => ({
  id: CREDIT_ID,
  role: 'producer',
  status,
  created_at: new Date('2026-10-12T09:00:00.000Z'),
  responded_at:
    status === 'accepted' ? new Date('2026-10-13T09:00:00.000Z') : null,
  requesting_id: RELEASE_PERSONA,
  requesting_handle: 'night-shift',
  requesting_display_name: 'Night Shift',
  requesting_kind: 'dj',
  requesting_avatar_url: null,
  requesting_is_public: true,
  credited_id: CREDITED_PERSONA,
  credited_handle: 'river-ink',
  credited_display_name: 'River Ink',
  credited_kind: 'visual_artist',
  credited_avatar_url: null,
  credited_is_public: true,
  track_id: TRACK_ID,
  track_title: 'Opening',
  release_id: 'f7000000-0000-4000-8000-000000000006',
  release_title: 'Lisbon at four',
  release_cover_key: null,
});

const credit = (overrides: Partial<StudioPersonaCredit> = {}) => ({
  id: CREDIT_ID,
  trackId: TRACK_ID,
  subprofileId: CREDITED_PERSONA,
  status: StudioPersonaCreditState.Pending,
  requesterDismissedAt: null,
  ...overrides,
});

describe('StudioCreditsInboxService', () => {
  let query: jest.Mock;
  let manager: {
    findOne: jest.Mock;
    exists: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
  };
  let memberOf: Set<string>;
  let eventEmitter: { emit: jest.Mock };
  let service: StudioCreditsInboxService;

  beforeEach(() => {
    memberOf = new Set([CREDITED_PERSONA]);
    query = jest.fn((sql: string) =>
      Promise.resolve(
        sql === INBOX_PENDING_COUNT_SQL
          ? [{ count: 2 }]
          : sql === INBOX_ACCEPTED_SQL
            ? [inboxRow('accepted')]
            : [inboxRow(sql === INBOX_ROW_BY_ID_SQL ? 'accepted' : 'pending')],
      ),
    );
    manager = {
      findOne: jest.fn().mockResolvedValue(credit()),
      exists: jest.fn(
        (_entity: unknown, options: { where: { subprofileId: string } }) =>
          Promise.resolve(memberOf.has(options.where.subprofileId)),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest
        .fn()
        .mockResolvedValue([
          { track_id: TRACK_ID, release_subprofile_id: RELEASE_PERSONA },
        ]),
    };
    eventEmitter = { emit: jest.fn() };
    service = new StudioCreditsInboxService(
      {
        query,
        transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
          Promise.resolve(work(manager as unknown as EntityManager)),
        ),
      } as unknown as DataSource,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  // The requester is blocked (or the persona went private): the visibility
  // read finds no row and every other read answers as before.
  function hideFromInbox(): void {
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql === INBOX_CREDIT_VISIBLE_SQL
          ? []
          : [{ track_id: TRACK_ID, release_subprofile_id: RELEASE_PERSONA }],
      ),
    );
  }

  it('reads both sections for every persona the viewer runs, 100 each', async () => {
    const inbox = await service.getInbox(VIEWER_ID);

    expect(query).toHaveBeenCalledWith(INBOX_REQUESTS_SQL, [VIEWER_ID, 100]);
    expect(query).toHaveBeenCalledWith(INBOX_ACCEPTED_SQL, [VIEWER_ID, 100]);
    expect(inbox.requests).toEqual([
      {
        id: CREDIT_ID,
        role: 'producer',
        status: 'pending',
        requestingPersona: {
          id: RELEASE_PERSONA,
          handle: 'night-shift',
          name: 'Night Shift',
          kind: 'dj',
          avatarUrl: null,
          isListenable: true,
        },
        creditedPersona: {
          id: CREDITED_PERSONA,
          handle: 'river-ink',
          name: 'River Ink',
          kind: 'visual_artist',
          avatarUrl: null,
          isListenable: false,
        },
        track: { id: TRACK_ID, title: 'Opening' },
        release: {
          id: 'f7000000-0000-4000-8000-000000000006',
          title: 'Lisbon at four',
          coverUrl: null,
        },
        createdAt: '2026-10-12T09:00:00.000Z',
        respondedAt: null,
      },
    ]);
    expect(inbox.accepted[0]?.respondedAt).toBe('2026-10-13T09:00:00.000Z');
    expect(INBOX_REQUESTS_SQL).toContain(
      'ORDER BY "credit"."created_at" DESC, "credit"."id" DESC',
    );
    expect(INBOX_ACCEPTED_SQL).toContain(
      'ORDER BY "credit"."responded_at" DESC NULLS LAST, "credit"."id" DESC',
    );
  });

  it('hides a request from a blocked requester in the list and the badge alike', () => {
    for (const sql of [
      INBOX_REQUESTS_SQL,
      INBOX_PENDING_COUNT_SQL,
      INBOX_ROW_BY_ID_SQL,
      INBOX_CREDIT_VISIBLE_SQL,
    ]) {
      expect(sql).toContain('FROM "blocks" "requester_block"');
      expect(sql).toContain('= "credit"."requested_by_user_id"');
      expect(sql).toContain(`"release"."status" <> 'taken_down'`);
      expect(sql).toContain(`"requesting"."visibility" = 'open'`);
      expect(sql).toContain('"viewer_member"."user_id" = $1');
    }
  });

  it('keeps an accepted credit findable after a block so the credited side can remove it', () => {
    expect(INBOX_ACCEPTED_SQL).not.toContain('"blocks"');
    expect(INBOX_ACCEPTED_SQL).not.toContain('requester_block');
    expect(INBOX_ACCEPTED_SQL).toContain(`"release"."status" <> 'taken_down'`);
    expect(INBOX_ACCEPTED_SQL).toContain(`"requesting"."visibility" = 'open'`);
    expect(INBOX_ACCEPTED_SQL).toContain('"viewer_member"."user_id" = $1');
    expect(INBOX_REQUESTS_SQL).toContain('FROM "blocks" "requester_block"');
  });

  it('names personas only and reads no member column', () => {
    for (const sql of [INBOX_REQUESTS_SQL, INBOX_ROW_BY_ID_SQL]) {
      expect(sql).not.toMatch(/"(requesting|credited)"\."user_id" AS/);
      expect(sql).not.toContain('"requested_by_user_id" AS');
    }
  });

  it('counts pending requests with the same filters', async () => {
    await expect(service.pendingCount(VIEWER_ID)).resolves.toEqual({
      count: 2,
    });
    expect(INBOX_PENDING_COUNT_SQL).toContain(`"credit"."status" = 'pending'`);
  });

  describe('accept', () => {
    it('accepts a pending credit, stamps the answer and tells the listener after the commit', async () => {
      const row = await service.accept(VIEWER_ID, CREDIT_ID);

      expect(manager.update).toHaveBeenCalledWith(
        StudioPersonaCredit,
        { id: CREDIT_ID },
        {
          status: StudioPersonaCreditState.Accepted,
          respondedAt: expect.any(Date),
        },
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(STUDIO_CREDIT_ACCEPTED, {
        creditId: CREDIT_ID,
        acceptingUserId: VIEWER_ID,
      });
      const updateOrder = manager.update.mock.invocationCallOrder[0] ?? 0;
      const emitOrder = eventEmitter.emit.mock.invocationCallOrder[0] ?? 0;
      expect(updateOrder).toBeLessThan(emitOrder);
      expect(row.status).toBe('accepted');
    });

    it('answers 404 for a credit the inbox hides, such as one from a blocked requester, and changes nothing', async () => {
      hideFromInbox();

      expect(await codeOf(service.accept(VIEWER_ID, CREDIT_ID))).toBe(
        'studio_credit_not_found',
      );
      expect(manager.query).toHaveBeenCalledWith(INBOX_CREDIT_VISIBLE_SQL, [
        VIEWER_ID,
        CREDIT_ID,
      ]);
      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('answers 404 to a member outside the credited persona, so an id is never confirmed', async () => {
      memberOf = new Set();
      expect(await codeOf(service.accept(VIEWER_ID, CREDIT_ID))).toBe(
        'studio_credit_not_found',
      );
      manager.findOne.mockResolvedValue(null);
      expect(await codeOf(service.accept(VIEWER_ID, CREDIT_ID))).toBe(
        'studio_credit_not_found',
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('locks the release row before the credit row, the order the release side takes', async () => {
      await service.accept(VIEWER_ID, CREDIT_ID);

      expect(manager.query).toHaveBeenCalledWith(LOCK_TRACK_RELEASE_SQL, [
        TRACK_ID,
      ]);
      expect(manager.findOne).toHaveBeenNthCalledWith(2, StudioPersonaCredit, {
        where: { id: CREDIT_ID },
        lock: { mode: 'pessimistic_write' },
      });
      const releaseLockOrder = manager.query.mock.invocationCallOrder[0] ?? 0;
      const creditLockOrder = manager.findOne.mock.invocationCallOrder[1] ?? 0;
      expect(releaseLockOrder).toBeLessThan(creditLockOrder);
      expect(LOCK_TRACK_RELEASE_SQL).toContain('FOR UPDATE');
    });

    it('refuses a credit that was already answered', async () => {
      manager.findOne.mockResolvedValue(
        credit({ status: StudioPersonaCreditState.Declined }),
      );
      expect(await codeOf(service.accept(VIEWER_ID, CREDIT_ID))).toBe(
        'studio_credit_not_pending',
      );
    });
  });

  describe('decline', () => {
    it('declines a pending credit and sends nothing', async () => {
      await service.decline(VIEWER_ID, CREDIT_ID);
      expect(manager.update).toHaveBeenCalledWith(
        StudioPersonaCredit,
        { id: CREDIT_ID },
        {
          status: StudioPersonaCreditState.Declined,
          respondedAt: expect.any(Date),
        },
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('declines a credit the inbox hides, so a member who blocked the requester can still answer', async () => {
      hideFromInbox();

      await service.decline(VIEWER_ID, CREDIT_ID);

      expect(manager.query).not.toHaveBeenCalledWith(
        INBOX_CREDIT_VISIBLE_SQL,
        expect.anything(),
      );
      expect(manager.update).toHaveBeenCalledWith(
        StudioPersonaCredit,
        { id: CREDIT_ID },
        {
          status: StudioPersonaCreditState.Declined,
          respondedAt: expect.any(Date),
        },
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('lets the credited side remove an accepted credit', async () => {
      manager.findOne.mockResolvedValue(
        credit({ status: StudioPersonaCreditState.Accepted }),
      );
      await service.remove(VIEWER_ID, CREDIT_ID);
      expect(manager.delete).toHaveBeenCalledWith(StudioPersonaCredit, {
        id: CREDIT_ID,
      });
    });

    it('sends the credited side to decline a pending one', async () => {
      expect(await codeOf(service.remove(VIEWER_ID, CREDIT_ID))).toBe(
        'studio_credit_not_accepted',
      );
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('gives the release side its own remove: a declined row is dismissed', async () => {
      memberOf = new Set([RELEASE_PERSONA]);
      manager.findOne.mockResolvedValue(
        credit({ status: StudioPersonaCreditState.Declined }),
      );
      await service.remove(VIEWER_ID, CREDIT_ID);
      expect(manager.query).toHaveBeenCalledWith(TRACK_RELEASE_PERSONA_SQL, [
        TRACK_ID,
      ]);
      expect(manager.update).toHaveBeenCalledWith(
        StudioPersonaCredit,
        { id: CREDIT_ID },
        { requesterDismissedAt: expect.any(Date) },
      );
    });

    it('answers 404 to a member on neither side and for a dismissed row', async () => {
      memberOf = new Set();
      expect(await codeOf(service.remove(VIEWER_ID, CREDIT_ID))).toBe(
        'studio_credit_not_found',
      );
      memberOf = new Set([RELEASE_PERSONA]);
      manager.findOne.mockResolvedValue(
        credit({
          status: StudioPersonaCreditState.Declined,
          requesterDismissedAt: new Date(),
        }),
      );
      expect(await codeOf(service.remove(VIEWER_ID, CREDIT_ID))).toBe(
        'studio_credit_not_found',
      );
    });
  });
});

import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { PAGE_SIZE } from '../common/pagination';
import { CreatorDraftSlotsService } from '../creator-drafts/creator-draft-slots.service';
import { EventVisibility } from '../events/entities/event.entity';
import type {
  CreatedEventDetail,
  EventDetail,
  EventSummary,
  UpdatedEventDetail,
} from '../events/event-response';
import { EventsService } from '../events/events.service';
import { GatheringFamily } from '../events/gathering-family';
import { houseMusicEventError } from '../events/house-music-event-errors';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import {
  AdminMusicEventsService,
  MUSIC_EVENT_ATTENTION_SQL,
  MUSIC_EVENT_IDS_BY_SLUG_SQL,
  MUSIC_EVENT_LINEUP_COUNTS_SQL,
  MUSIC_EVENT_PENDING_REQUEST_COUNTS_SQL,
} from './admin-music-events.service';
import { CreateMusicEventDto } from './dto/create-music-event.dto';
import { UpdateMusicEventDto } from './dto/update-music-event.dto';
import { HouseMusicEventScopeService } from './house-music-event-scope.service';

const HOUSE_USER_ID = 'house-user-1';
const STAFF_USER_ID = 'staff-user-1';
const FIRST_EVENT_ID = '5b0e2a4c-1d2f-4e6a-9b8c-0d1e2f3a4b5c';
const SECOND_EVENT_ID = '6c1f3b5d-2e3a-4f7b-8c9d-1e2f3a4b5c6d';

function detailFixture(overrides: Partial<EventDetail>): EventDetail {
  const fixture: Partial<EventDetail> = {
    slug: 'friday-set',
    title: 'Friday set',
    ...overrides,
  };
  return fixture as EventDetail;
}

function summaryFixture(overrides: Partial<EventSummary>): EventSummary {
  const fixture: Partial<EventSummary> = {
    slug: 'friday-set',
    title: 'Friday set',
    ...overrides,
  };
  return fixture as EventSummary;
}

function createBody(
  overrides: Partial<CreateMusicEventDto>,
): CreateMusicEventDto {
  return Object.assign(new CreateMusicEventDto(), {
    title: 'Friday set',
    description: 'Three acts and a late set.',
    startAt: '2026-11-20T21:00:00.000Z',
    timezone: 'Europe/Lisbon',
    ...overrides,
  });
}

function updateBody(
  overrides: Partial<UpdateMusicEventDto>,
): UpdateMusicEventDto {
  return Object.assign(new UpdateMusicEventDto(), overrides);
}

async function expectReasonCode(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(status);
  expect(exception.getResponse()).toMatchObject({ code });
}

describe('AdminMusicEventsService', () => {
  let service: AdminMusicEventsService;
  const eventsCreate = jest.fn();
  const eventsGetBySlug = jest.fn();
  const eventsUpdate = jest.fn();
  const eventsCancel = jest.fn();
  const listHostedInFamily = jest.fn();
  const houseUserId = jest.fn();
  const loadOrNotFound = jest.fn();
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>();
  const auditCreate = jest.fn((row: Partial<ModAuditLog>) => row);
  const auditSave = jest.fn();
  const discardAfterPublish = jest.fn();

  /** Answers each SQL constant with its own rows. */
  const answerQueries = (rowsBySql: Map<string, unknown[]>): void => {
    query.mockImplementation((sql: string) =>
      Promise.resolve(rowsBySql.get(sql) ?? []),
    );
  };

  const savedAuditRows = (): unknown[] =>
    auditSave.mock.calls.map(([row]: [unknown]) => row);

  beforeEach(async () => {
    for (const mock of [
      eventsCreate,
      eventsGetBySlug,
      eventsUpdate,
      eventsCancel,
      listHostedInFamily,
      loadOrNotFound,
      query,
      auditSave,
      discardAfterPublish,
    ]) {
      mock.mockReset();
    }
    auditCreate.mockClear();
    houseUserId.mockReset().mockResolvedValue(HOUSE_USER_ID);
    loadOrNotFound.mockResolvedValue({
      event: { id: FIRST_EVENT_ID, slug: 'friday-set' },
      houseUserId: HOUSE_USER_ID,
    });
    auditSave.mockResolvedValue(undefined);
    answerQueries(new Map());
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminMusicEventsService,
        {
          provide: EventsService,
          useValue: {
            create: eventsCreate,
            getBySlug: eventsGetBySlug,
            update: eventsUpdate,
            cancel: eventsCancel,
            listHostedInFamily,
          },
        },
        {
          provide: HouseMusicEventScopeService,
          useValue: { houseUserId, loadOrNotFound },
        },
        { provide: getDataSourceToken(), useValue: { query } },
        {
          provide: getRepositoryToken(ModAuditLog),
          useValue: { create: auditCreate, save: auditSave },
        },
        {
          provide: CreatorDraftSlotsService,
          useValue: { discardAfterPublish },
        },
      ],
    }).compile();
    service = moduleRef.get(AdminMusicEventsService);
  });

  it('creates as the house with the family fixed to music and never discards a draft', async () => {
    const created: Partial<CreatedEventDetail> = {
      ...detailFixture({}),
      occurrenceSlugs: ['friday-set'],
    };
    eventsCreate.mockResolvedValue(created);
    const body = createBody({ venue: 'The house floor' });

    await expect(service.create(STAFF_USER_ID, body)).resolves.toBe(created);

    expect(eventsCreate.mock.calls).toEqual([
      [HOUSE_USER_ID, { ...body, gatheringFamily: GatheringFamily.Music }],
    ]);
    expect(discardAfterPublish).not.toHaveBeenCalled();
  });

  it('refuses a create in another family with house_event_family_locked', async () => {
    await expectReasonCode(
      service.create(
        STAFF_USER_ID,
        createBody({ gatheringFamily: GatheringFamily.Party }),
      ),
      403,
      'house_event_family_locked',
    );
    await expectReasonCode(
      service.create(STAFF_USER_ID, createBody({ gatheringFamily: null })),
      403,
      'house_event_family_locked',
    );
    expect(eventsCreate).not.toHaveBeenCalled();
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('refuses community-only visibility on create and update with music_event_community_unavailable', async () => {
    await expectReasonCode(
      service.create(
        STAFF_USER_ID,
        createBody({ visibility: EventVisibility.Community }),
      ),
      400,
      'music_event_community_unavailable',
    );
    await expectReasonCode(
      service.update(
        STAFF_USER_ID,
        'friday-set',
        updateBody({ visibility: EventVisibility.Community }),
        'this',
      ),
      400,
      'music_event_community_unavailable',
    );
    expect(eventsCreate).not.toHaveBeenCalled();
    expect(eventsUpdate).not.toHaveBeenCalled();
  });

  it('updates as the house with the staff member as uploader', async () => {
    const updated: Partial<UpdatedEventDetail> = {
      ...detailFixture({ title: 'Friday late set' }),
      notifiedCount: 0,
    };
    eventsUpdate.mockResolvedValue(updated);
    const body = updateBody({ title: 'Friday late set' });

    await expect(
      service.update(STAFF_USER_ID, 'friday-set', body, 'future'),
    ).resolves.toBe(updated);

    expect(loadOrNotFound).toHaveBeenCalledWith('friday-set');
    expect(eventsUpdate.mock.calls).toEqual([
      [
        'friday-set',
        HOUSE_USER_ID,
        body,
        'future',
        { uploaderUserId: STAFF_USER_ID },
      ],
    ]);
  });

  it('lists with lineup counts, pending requests and attention totals', async () => {
    listHostedInFamily.mockResolvedValue({
      items: [
        summaryFixture({ slug: 'friday-set' }),
        summaryFixture({ slug: 'saturday-set', title: 'Saturday set' }),
      ],
      hasMore: true,
    });
    answerQueries(
      new Map<string, unknown[]>([
        [
          MUSIC_EVENT_IDS_BY_SLUG_SQL,
          [
            { id: SECOND_EVENT_ID, slug: 'saturday-set' },
            { id: FIRST_EVENT_ID, slug: 'friday-set' },
          ],
        ],
        [
          MUSIC_EVENT_LINEUP_COUNTS_SQL,
          [
            { event_id: FIRST_EVENT_ID, status: 'pending', total: 2 },
            { event_id: FIRST_EVENT_ID, status: 'accepted', total: 3 },
            { event_id: SECOND_EVENT_ID, status: 'declined', total: 1 },
          ],
        ],
        [
          MUSIC_EVENT_PENDING_REQUEST_COUNTS_SQL,
          [{ event_id: SECOND_EVENT_ID, total: 4 }],
        ],
        [
          MUSIC_EVENT_ATTENTION_SQL,
          [{ pending_invite_request_count: 7, pending_lineup_count: 5 }],
        ],
      ]),
    );

    const page = await service.list({ bucket: 'past', page: 2 });

    expect(listHostedInFamily.mock.calls).toEqual([
      [HOUSE_USER_ID, GatheringFamily.Music, 'past', 2],
    ]);
    expect(
      page.items.map((item) => ({
        slug: item.slug,
        lineupCounts: item.lineupCounts,
        pendingInviteRequestCount: item.pendingInviteRequestCount,
      })),
    ).toEqual([
      {
        slug: 'friday-set',
        lineupCounts: { pending: 2, accepted: 3, declined: 0 },
        pendingInviteRequestCount: 0,
      },
      {
        slug: 'saturday-set',
        lineupCounts: { pending: 0, accepted: 0, declined: 1 },
        pendingInviteRequestCount: 4,
      },
    ]);
    expect({
      page: page.page,
      pageSize: page.pageSize,
      hasMore: page.hasMore,
      attention: page.attention,
    }).toEqual({
      page: 2,
      pageSize: PAGE_SIZE,
      hasMore: true,
      attention: { pendingInviteRequestCount: 7, pendingLineupCount: 5 },
    });
    const attentionCalls = query.mock.calls.filter(
      ([sql]) => sql === MUSIC_EVENT_ATTENTION_SQL,
    );
    expect(
      attentionCalls.map(([, parameters]) => parameters.slice(0, 2)),
    ).toEqual([[HOUSE_USER_ID, GatheringFamily.Music]]);
    const countCalls = query.mock.calls.filter(
      ([sql]) =>
        sql === MUSIC_EVENT_LINEUP_COUNTS_SQL ||
        sql === MUSIC_EVENT_PENDING_REQUEST_COUNTS_SQL,
    );
    expect(countCalls.map(([, parameters]) => parameters)).toEqual([
      [[SECOND_EVENT_ID, FIRST_EVENT_ID]],
      [[SECOND_EVENT_ID, FIRST_EVENT_ID]],
    ]);
  });

  it('fills zero counts for an event with no lineup and no requests', async () => {
    listHostedInFamily.mockResolvedValue({
      items: [summaryFixture({ slug: 'quiet-set' })],
      hasMore: false,
    });
    answerQueries(
      new Map<string, unknown[]>([
        [
          MUSIC_EVENT_IDS_BY_SLUG_SQL,
          [{ id: FIRST_EVENT_ID, slug: 'quiet-set' }],
        ],
      ]),
    );

    const page = await service.list({});

    expect(listHostedInFamily.mock.calls).toEqual([
      [HOUSE_USER_ID, GatheringFamily.Music, 'upcoming', 1],
    ]);
    expect(
      page.items.map((item) => ({
        slug: item.slug,
        lineupCounts: item.lineupCounts,
        pendingInviteRequestCount: item.pendingInviteRequestCount,
      })),
    ).toEqual([
      {
        slug: 'quiet-set',
        lineupCounts: { pending: 0, accepted: 0, declined: 0 },
        pendingInviteRequestCount: 0,
      },
    ]);
    expect(page.attention).toEqual({
      pendingInviteRequestCount: 0,
      pendingLineupCount: 0,
    });
  });

  it('answers music_event_not_found for read, update and cancel before calling EventsService', async () => {
    loadOrNotFound.mockRejectedValue(
      houseMusicEventError('music_event_not_found'),
    );

    await expectReasonCode(
      service.read('member-party'),
      404,
      'music_event_not_found',
    );
    await expectReasonCode(
      service.update(
        STAFF_USER_ID,
        'member-party',
        updateBody({ visibility: EventVisibility.Community }),
        'this',
      ),
      404,
      'music_event_not_found',
    );
    await expectReasonCode(
      service.cancel(STAFF_USER_ID, 'member-party', 'this'),
      404,
      'music_event_not_found',
    );
    expect(eventsGetBySlug).not.toHaveBeenCalled();
    expect(eventsUpdate).not.toHaveBeenCalled();
    expect(eventsCancel).not.toHaveBeenCalled();
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('reads as the house with the guest preview passed through', async () => {
    const detail = detailFixture({});
    eventsGetBySlug.mockResolvedValue(detail);

    await expect(service.read('friday-set', 'going')).resolves.toBe(detail);

    expect(eventsGetBySlug.mock.calls).toEqual([
      ['friday-set', HOUSE_USER_ID, 'going'],
    ]);
  });

  it('writes one audit row per create, update and cancel', async () => {
    eventsCreate.mockResolvedValue({
      ...detailFixture({}),
      occurrenceSlugs: ['friday-set', 'friday-set-2', 'friday-set-3'],
    });
    eventsUpdate.mockResolvedValue({
      ...detailFixture({ title: 'Friday late set' }),
      notifiedCount: 2,
    });
    eventsCancel.mockResolvedValue(detailFixture({ title: 'Friday late set' }));

    await service.create(STAFF_USER_ID, createBody({}));
    await service.update(
      STAFF_USER_ID,
      'friday-set',
      updateBody({ title: 'Friday late set' }),
      'future',
    );
    await service.cancel(STAFF_USER_ID, 'friday-set', 'this');

    expect(savedAuditRows()).toEqual([
      expect.objectContaining({
        actorId: STAFF_USER_ID,
        action: 'music_event_created',
        targetUserId: null,
        targetName: 'Friday set',
        note: 'friday-set: 3 dates',
      }),
      expect.objectContaining({
        actorId: STAFF_USER_ID,
        action: 'music_event_updated',
        targetUserId: null,
        targetName: 'Friday late set',
        note: 'friday-set: scope future',
      }),
      expect.objectContaining({
        actorId: STAFF_USER_ID,
        action: 'music_event_cancelled',
        targetUserId: null,
        targetName: 'Friday late set',
        note: 'friday-set: scope this',
      }),
    ]);
  });

  it('notes no date count for a single-date create', async () => {
    eventsCreate.mockResolvedValue({
      ...detailFixture({}),
      occurrenceSlugs: ['friday-set'],
    });

    await service.create(STAFF_USER_ID, createBody({}));

    expect(savedAuditRows()).toEqual([
      expect.objectContaining({
        action: 'music_event_created',
        note: 'friday-set',
      }),
    ]);
  });
});

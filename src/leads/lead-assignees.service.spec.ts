import { HttpException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from '../common/image-url';
import { PRIVATE_PARAMETERS_COMMENT } from '../database/private-parameters-logger';
import { MediaCropService } from '../media-crops/media-crops.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { foldedHaystack } from '../search/search-text';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { LeadAssignee } from './entities/lead-assignee.entity';
import { LeadEntry } from './entities/lead-entry.entity';
import { Lead } from './entities/lead.entity';
import {
  LEAD_STAFF_CALLER_FIRST_SQL,
  LEAD_STAFF_SEARCH_HAYSTACK,
  LEAD_STAFF_SEARCH_SQL,
  LeadAssigneesService,
} from './lead-assignees.service';
import { TOUCH_LEAD_SQL } from './lead-entries.service';
import type { LeadCaller, LeadDTO } from './lead-response';
import {
  LEAD_STAFF_ELIGIBLE_SQL,
  leadStaffEligibility,
  type LeadStaffEligibility,
} from './lead-staff-eligibility';
import {
  LEAD_ASSIGNEE_NOT_STAFF_MESSAGES,
  LEAD_ASSIGNEE_REFUSAL_REASONS,
} from './leads.constants';
import { LeadsService, LOCK_LEADS_SQL } from './leads.service';

jest.mock('./lead-staff-eligibility', () => ({
  ...jest.requireActual<object>('./lead-staff-eligibility'),
  leadStaffEligibility: jest.fn(),
}));

const eligibilityMock = leadStaffEligibility as jest.MockedFunction<
  typeof leadStaffEligibility
>;

const CALLER_ID = 'd8500000-0000-4000-8000-00000000000a';
const TARGET_ID = 'd8500000-0000-4000-8000-000000000002';
const OTHER_STAFF_ID = 'd8500000-0000-4000-8000-000000000003';
const LEAD_ID = 'd8500000-0000-4000-8000-000000000011';

const CALLER: LeadCaller = { userId: CALLER_ID, role: UserRole.Member };

const LEAD_DTO = { id: LEAD_ID, assignees: [] } as unknown as LeadDTO;

// Well-formed storage keys: `toImageUrl` drops anything that does not parse
// as one.
const AVATAR_KEY =
  'persona/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg';
const HIDDEN_AVATAR_KEY =
  'persona/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.jpg';

const SUMMARY_KEYS = ['avatarCrop', 'avatarUrl', 'displayName', 'id', 'slug'];

interface RefusalOutcome {
  code?: string;
  status?: number;
  body?: Record<string, unknown>;
}

/** The code, status and body of a refused call, or `{}` when it resolved. */
async function codeOf(promise: Promise<unknown>): Promise<RefusalOutcome> {
  try {
    await promise;
    return {};
  } catch (error) {
    const httpError = error as HttpException;
    const body = httpError.getResponse() as Record<string, unknown>;
    return {
      code: body.code as string | undefined,
      status: httpError.getStatus(),
      body,
    };
  }
}

/** The global call order of one call of a mock. Throws when that call never
 *  happened, so an order assertion can not pass on a missing call. */
function callOrderOf(mockFunction: jest.Mock, callIndex = 0): number {
  const callOrder = mockFunction.mock.invocationCallOrder[callIndex];
  if (callOrder === undefined) {
    throw new Error(`Call ${callIndex} of the mock never happened`);
  }
  return callOrder;
}

interface QueryBuilderStub {
  innerJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  select: jest.Mock;
  addSelect: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  setParameter: jest.Mock;
  limit: jest.Mock;
  comment: jest.Mock;
  getRawMany: jest.Mock;
}

interface PickerRow {
  user_id: string;
  slug: string;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  photo_visible: boolean;
  email?: string;
}

function pickerRow(overrides: Partial<PickerRow> = {}): PickerRow {
  return {
    user_id: OTHER_STAFF_ID,
    slug: 'rui-staff',
    first_name: 'Rui',
    last_name: 'Staff',
    avatar_url: AVATAR_KEY,
    photo_visible: true,
    ...overrides,
  };
}

describe('LeadAssigneesService', () => {
  let manager: {
    query: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    insert: jest.Mock;
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: { manager: typeof manager; transaction: jest.Mock };
  let leads: { getLead: jest.Mock };
  let notifications: { create: jest.Mock };
  let mediaCropService: { getMany: jest.Mock };
  let service: LeadAssigneesService;
  let warnSpy: jest.SpyInstance;
  let builder: QueryBuilderStub;
  let pickerRows: PickerRow[];
  let storedLead: Pick<Lead, 'id'> | null;
  let storedAssignee: Pick<LeadAssignee, 'userId'> | null;
  /** Called once each time a transaction's work has resolved. */
  let transactionSettled: jest.Mock;

  function buildQueryBuilder(): QueryBuilderStub {
    const stub = {} as QueryBuilderStub;
    const chainable: (keyof QueryBuilderStub)[] = [
      'innerJoin',
      'where',
      'andWhere',
      'select',
      'addSelect',
      'orderBy',
      'addOrderBy',
      'setParameter',
      'limit',
      'comment',
    ];
    for (const methodName of chainable) {
      stub[methodName] = jest.fn(() => stub);
    }
    stub.getRawMany = jest.fn(() => Promise.resolve(pickerRows));
    return stub;
  }

  /** The global call order of the first `manager.query` call running `sql`.
   *  Throws when no call ran it. */
  function queryCallOrderOf(sql: string): number {
    const callIndex = manager.query.mock.calls.findIndex(
      (call: unknown[]) => call[0] === sql,
    );
    if (callIndex === -1) {
      throw new Error('No query call ran this SQL');
    }
    return callOrderOf(manager.query, callIndex);
  }

  function hasTouched(): boolean {
    return manager.query.mock.calls.some(
      (call: unknown[]) => call[0] === TOUCH_LEAD_SQL,
    );
  }

  function mockEligibility(result: LeadStaffEligibility): void {
    eligibilityMock.mockResolvedValue(result);
  }

  beforeEach(() => {
    setImageUrlBase('https://api.test');
    eligibilityMock.mockReset();
    mockEligibility({ kind: 'eligible' });
    pickerRows = [];
    storedLead = { id: LEAD_ID };
    storedAssignee = null;
    builder = buildQueryBuilder();
    transactionSettled = jest.fn();
    manager = {
      query: jest.fn().mockResolvedValue([]),
      findOne: jest.fn((entity: unknown) => {
        if (entity === Lead) return Promise.resolve(storedLead);
        if (entity === LeadAssignee) return Promise.resolve(storedAssignee);
        return Promise.resolve(null);
      }),
      count: jest.fn().mockResolvedValue(0),
      insert: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn((_entity: unknown, row: object) => ({ ...row })),
      save: jest.fn((_entity: unknown, row: object) => Promise.resolve(row)),
      createQueryBuilder: jest.fn(() => builder),
    };
    dataSource = {
      manager,
      transaction: jest.fn(
        async (work: (transactionManager: typeof manager) => unknown) => {
          const result = await work(manager);
          transactionSettled();
          return result;
        },
      ),
    };
    leads = { getLead: jest.fn().mockResolvedValue(LEAD_DTO) };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    service = new LeadAssigneesService(
      dataSource as unknown as DataSource,
      leads as unknown as LeadsService,
      notifications as unknown as NotificationsService,
      mediaCropService as unknown as MediaCropService,
    );
  });

  afterEach(() => {
    warnSpy.mockRestore();
    resetImageUrlBaseForTesting();
  });

  describe('searchStaff', () => {
    it('previews the caller first then five by name for a blank query', async () => {
      for (const blankQuery of [undefined, '   ', ['a', 'b'], 5]) {
        builder = buildQueryBuilder();
        manager.createQueryBuilder.mockClear();

        await service.searchStaff(blankQuery, CALLER);

        expect(manager.createQueryBuilder).toHaveBeenCalledWith(User, 'staff');
        expect(builder.innerJoin).toHaveBeenCalledWith(
          Profile,
          'profile',
          '"profile"."user_id" = "staff"."id"',
        );
        expect(builder.where).toHaveBeenCalledWith(LEAD_STAFF_ELIGIBLE_SQL);
        expect(builder.andWhere).not.toHaveBeenCalled();
        expect(builder.orderBy).toHaveBeenCalledWith(
          LEAD_STAFF_CALLER_FIRST_SQL,
          'ASC',
        );
        expect(builder.setParameter).toHaveBeenCalledWith(
          'callerId',
          CALLER_ID,
        );
        expect(builder.addOrderBy.mock.calls).toEqual([
          ['lower("profile"."first_name")', 'ASC'],
          ['lower("profile"."last_name")', 'ASC'],
          ['staff.id', 'ASC'],
        ]);
        expect(builder.limit).toHaveBeenCalledWith(5);
      }
    });

    it('searches first name, last name and slug folded for a typed query, twenty by name', async () => {
      await service.searchStaff(' Ana_% ', CALLER);

      expect(builder.andWhere).toHaveBeenCalledWith(LEAD_STAFF_SEARCH_SQL, {
        term: '%Ana\\_\\%%',
      });
      expect(builder.orderBy).toHaveBeenCalledWith(
        'lower("profile"."first_name")',
        'ASC',
      );
      const orderCalls: unknown[][] = [
        ...(builder.orderBy.mock.calls as unknown[][]),
        ...(builder.addOrderBy.mock.calls as unknown[][]),
      ];
      expect(
        orderCalls.filter((call) => call[0] === LEAD_STAFF_CALLER_FIRST_SQL),
      ).toHaveLength(0);
      expect(builder.limit).toHaveBeenCalledWith(20);

      builder = buildQueryBuilder();
      await service.searchStaff('🌈'.repeat(150), CALLER);
      expect(builder.andWhere).toHaveBeenCalledWith(LEAD_STAFF_SEARCH_SQL, {
        term: `%${'🌈'.repeat(100)}%`,
      });

      expect(LEAD_STAFF_SEARCH_HAYSTACK).toBe(
        foldedHaystack('profile', ['first_name', 'last_name', 'slug']),
      );
    });

    it('selects five columns and the photo flag from eligible staff and answers summaries only', async () => {
      pickerRows = [
        pickerRow({ email: 'rui@example.test' }),
        pickerRow({
          user_id: CALLER_ID,
          slug: 'caller-staff',
          first_name: 'Ana',
          last_name: 'Caller',
          avatar_url: null,
        }),
        pickerRow({
          user_id: TARGET_ID,
          slug: 'hidden-staff',
          avatar_url: HIDDEN_AVATAR_KEY,
          photo_visible: false,
        }),
      ];

      const result = await service.searchStaff('', CALLER);

      expect(builder.select).toHaveBeenCalledWith('staff.id', 'user_id');
      expect(builder.addSelect.mock.calls).toEqual([
        ['profile.slug', 'slug'],
        ['profile.firstName', 'first_name'],
        ['profile.lastName', 'last_name'],
        ['profile.avatarUrl', 'avatar_url'],
        ['profile.photoVisible', 'photo_visible'],
      ]);
      expect(result.items).toHaveLength(3);
      for (const item of result.items) {
        expect(Object.keys(item).sort()).toEqual(SUMMARY_KEYS);
      }
      expect(result.items[0]).toEqual({
        id: OTHER_STAFF_ID,
        slug: 'rui-staff',
        displayName: 'Rui Staff',
        avatarUrl: toImageUrl(AVATAR_KEY),
        avatarCrop: null,
      });
      expect(result.items[2]).toEqual({
        id: TARGET_ID,
        slug: 'hidden-staff',
        displayName: 'Rui Staff',
        avatarUrl: null,
        avatarCrop: null,
      });
      expect(mediaCropService.getMany).toHaveBeenCalledTimes(1);
      expect(mediaCropService.getMany).toHaveBeenCalledWith([AVATAR_KEY]);
    });

    it('keeps the typed text out of the query log', async () => {
      await service.searchStaff('', CALLER);
      expect(builder.comment).toHaveBeenCalledTimes(1);
      expect(builder.comment).toHaveBeenCalledWith(PRIVATE_PARAMETERS_COMMENT);

      builder = buildQueryBuilder();
      await service.searchStaff('Ana', CALLER);
      expect(builder.comment).toHaveBeenCalledTimes(1);
      expect(builder.comment).toHaveBeenCalledWith(PRIVATE_PARAMETERS_COMMENT);
    });
  });

  describe('assign', () => {
    it('checks the assign route in the contract order', async () => {
      expect(
        await codeOf(service.assign('nope', CALLER, { userId: 'nope' })),
      ).toMatchObject({ code: 'LEAD_NOT_FOUND', status: 404 });
      for (const body of [{}, undefined, { userId: 5 }, { userId: 'nope' }]) {
        expect(
          await codeOf(service.assign(LEAD_ID, CALLER, body)),
        ).toMatchObject({ code: 'LEAD_ASSIGNEE_NOT_FOUND', status: 400 });
      }
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('locks the leads table then the lead row', async () => {
      await service.assign(LEAD_ID, CALLER, { userId: TARGET_ID });

      expect(manager.query.mock.calls[0]).toEqual([LOCK_LEADS_SQL]);
      expect(callOrderOf(manager.query)).toBeLessThan(
        callOrderOf(manager.findOne),
      );
      expect(manager.findOne).toHaveBeenNthCalledWith(1, Lead, {
        where: { id: LEAD_ID },
        select: { id: true },
        lock: { mode: 'pessimistic_write' },
      });

      eligibilityMock.mockClear();
      storedLead = null;
      expect(
        await codeOf(service.assign(LEAD_ID, CALLER, { userId: TARGET_ID })),
      ).toMatchObject({ code: 'LEAD_NOT_FOUND', status: 404 });
      expect(eligibilityMock).not.toHaveBeenCalled();
    });

    it('answers an existing assignment unchanged before any eligibility check', async () => {
      storedAssignee = { userId: TARGET_ID };

      const result = await service.assign(LEAD_ID, CALLER, {
        userId: TARGET_ID,
      });

      expect(manager.findOne).toHaveBeenCalledWith(LeadAssignee, {
        where: { leadId: LEAD_ID, userId: TARGET_ID },
        select: { userId: true },
      });
      expect(eligibilityMock).not.toHaveBeenCalled();
      expect(manager.count).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
      expect(hasTouched()).toBe(false);
      expect(notifications.create).not.toHaveBeenCalled();
      expect(leads.getLead).toHaveBeenCalledWith(LEAD_ID, CALLER);
      expect(result).toBe(LEAD_DTO);

      mockEligibility({ kind: 'ineligible', reason: 'suspended' });
      await expect(
        service.assign(LEAD_ID, CALLER, { userId: TARGET_ID }),
      ).resolves.toBe(LEAD_DTO);
    });

    it('answers 404 LEAD_ASSIGNEE_NOT_FOUND for no such account', async () => {
      mockEligibility({ kind: 'not_found' });

      expect(
        await codeOf(service.assign(LEAD_ID, CALLER, { userId: TARGET_ID })),
      ).toMatchObject({ code: 'LEAD_ASSIGNEE_NOT_FOUND', status: 404 });
      expect(eligibilityMock).toHaveBeenCalledWith(manager, TARGET_ID);
      const existingReadIndex = manager.findOne.mock.calls.findIndex(
        (call: unknown[]) => call[0] === LeadAssignee,
      );
      expect(callOrderOf(manager.findOne, existingReadIndex)).toBeLessThan(
        callOrderOf(eligibilityMock as unknown as jest.Mock),
      );
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it.each(LEAD_ASSIGNEE_REFUSAL_REASONS)(
      'answers 400 LEAD_ASSIGNEE_NOT_STAFF with reason %s',
      async (reason) => {
        mockEligibility({ kind: 'ineligible', reason });

        const outcome = await codeOf(
          service.assign(LEAD_ID, CALLER, { userId: TARGET_ID }),
        );

        expect(outcome.status).toBe(400);
        expect(outcome.body).toMatchObject({
          code: 'LEAD_ASSIGNEE_NOT_STAFF',
          reason,
          message: LEAD_ASSIGNEE_NOT_STAFF_MESSAGES[reason],
        });
        expect(manager.insert).not.toHaveBeenCalled();
      },
    );

    it('refuses an eleventh person with 409 after the eligibility check', async () => {
      manager.count.mockResolvedValue(10);
      expect(
        await codeOf(service.assign(LEAD_ID, CALLER, { userId: TARGET_ID })),
      ).toMatchObject({ code: 'LEAD_TOO_MANY_ASSIGNEES', status: 409 });
      expect(manager.count).toHaveBeenCalledWith(LeadAssignee, {
        where: { leadId: LEAD_ID },
      });
      expect(manager.insert).not.toHaveBeenCalled();

      mockEligibility({ kind: 'ineligible', reason: 'no_access' });
      expect(
        await codeOf(service.assign(LEAD_ID, CALLER, { userId: TARGET_ID })),
      ).toMatchObject({ code: 'LEAD_ASSIGNEE_NOT_STAFF' });

      mockEligibility({ kind: 'eligible' });
      manager.count.mockResolvedValue(9);
      await expect(
        service.assign(LEAD_ID, CALLER, { userId: TARGET_ID }),
      ).resolves.toBe(LEAD_DTO);
      expect(manager.insert).toHaveBeenCalledTimes(1);
    });

    it('writes the assignment, the entry and the stamp in order', async () => {
      await service.assign(LEAD_ID, CALLER, { userId: TARGET_ID });

      expect(manager.insert).toHaveBeenCalledWith(LeadAssignee, {
        leadId: LEAD_ID,
        userId: TARGET_ID,
        assignedById: CALLER_ID,
      });
      expect(manager.save).toHaveBeenCalledWith(LeadEntry, {
        leadId: LEAD_ID,
        kind: 'assignee_added',
        authorId: CALLER_ID,
        subjectUserId: TARGET_ID,
      });
      expect(manager.query).toHaveBeenCalledWith(TOUCH_LEAD_SQL, [LEAD_ID]);
      expect(callOrderOf(manager.insert)).toBeLessThan(
        callOrderOf(manager.save),
      );
      expect(callOrderOf(manager.save)).toBeLessThan(
        queryCallOrderOf(TOUCH_LEAD_SQL),
      );
      expect(callOrderOf(transactionSettled)).toBeLessThan(
        callOrderOf(leads.getLead),
      );
    });

    it('stores the lower-case lead id in the notification for an upper-case path id', async () => {
      await service.assign(LEAD_ID.toUpperCase(), CALLER, {
        userId: TARGET_ID,
      });

      expect(notifications.create.mock.calls).toEqual([
        [
          TARGET_ID,
          NotificationType.LeadAssigned,
          { leadId: LEAD_ID, assignedById: CALLER_ID },
        ],
      ]);
    });

    it('notifies someone else after the commit with ids only', async () => {
      await service.assign(LEAD_ID, CALLER, { userId: TARGET_ID });

      expect(notifications.create.mock.calls).toEqual([
        [
          TARGET_ID,
          NotificationType.LeadAssigned,
          { leadId: LEAD_ID, assignedById: CALLER_ID },
        ],
      ]);
      expect(queryCallOrderOf(TOUCH_LEAD_SQL)).toBeLessThan(
        callOrderOf(notifications.create),
      );
      expect(callOrderOf(transactionSettled)).toBeLessThan(
        callOrderOf(notifications.create),
      );

      notifications.create.mockClear();
      manager.query.mockImplementation((sql: string) =>
        sql === TOUCH_LEAD_SQL
          ? Promise.reject(new Error('write failed'))
          : Promise.resolve([]),
      );
      await expect(
        service.assign(LEAD_ID, CALLER, { userId: TARGET_ID }),
      ).rejects.toThrow('write failed');
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('sends nothing when the caller assigns themselves in any letter case', async () => {
      for (const spelling of [CALLER_ID, CALLER_ID.toUpperCase()]) {
        manager.insert.mockClear();

        await service.assign(LEAD_ID, CALLER, { userId: spelling });

        expect(manager.insert).toHaveBeenCalledWith(
          LeadAssignee,
          expect.objectContaining({ userId: CALLER_ID }),
        );
      }
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('still answers the lead when the notification fails, logging ids only', async () => {
      notifications.create.mockRejectedValue(new Error('Secret Lead Name'));

      await expect(
        service.assign(LEAD_ID, CALLER, { userId: TARGET_ID }),
      ).resolves.toBe(LEAD_DTO);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const firstWarnCall = warnSpy.mock.calls[0] as unknown[] | undefined;
      const loggedMessage = String(firstWarnCall?.[0]);
      expect(loggedMessage).toContain(LEAD_ID);
      expect(loggedMessage).toContain(TARGET_ID);
      expect(loggedMessage).toContain(CALLER_ID);
      expect(loggedMessage).not.toContain('Secret');
    });
  });

  describe('unassign', () => {
    it('checks the unassign route in the contract order', async () => {
      expect(
        await codeOf(service.unassign('nope', 'nope', CALLER)),
      ).toMatchObject({ code: 'LEAD_NOT_FOUND', status: 404 });
      expect(
        await codeOf(service.unassign(LEAD_ID, 'nope', CALLER)),
      ).toMatchObject({ code: 'LEAD_ASSIGNEE_NOT_FOUND', status: 404 });
      expect(dataSource.transaction).not.toHaveBeenCalled();

      storedLead = null;
      expect(
        await codeOf(service.unassign(LEAD_ID, TARGET_ID, CALLER)),
      ).toMatchObject({ code: 'LEAD_NOT_FOUND', status: 404 });
      expect(manager.query.mock.calls[0]).toEqual([LOCK_LEADS_SQL]);
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('answers the lead unchanged when the person is not in charge', async () => {
      manager.delete.mockResolvedValue({ affected: 0 });

      const result = await service.unassign(LEAD_ID, TARGET_ID, CALLER);

      expect(manager.save).not.toHaveBeenCalled();
      expect(hasTouched()).toBe(false);
      expect(leads.getLead).toHaveBeenCalledWith(LEAD_ID, CALLER);
      expect(result).toBe(LEAD_DTO);
    });

    it('removes the person and records it with no notification and no eligibility check', async () => {
      for (const removedId of [TARGET_ID, CALLER_ID]) {
        manager.delete.mockClear();
        manager.save.mockClear();
        manager.query.mockClear();

        await service.unassign(LEAD_ID, removedId, CALLER);

        expect(manager.delete).toHaveBeenCalledWith(LeadAssignee, {
          leadId: LEAD_ID,
          userId: removedId,
        });
        expect(manager.save).toHaveBeenCalledWith(LeadEntry, {
          leadId: LEAD_ID,
          kind: 'assignee_removed',
          authorId: CALLER_ID,
          subjectUserId: removedId,
        });
        expect(manager.query).toHaveBeenCalledWith(TOUCH_LEAD_SQL, [LEAD_ID]);
        expect(callOrderOf(manager.delete)).toBeLessThan(
          callOrderOf(manager.save),
        );
        expect(callOrderOf(manager.save)).toBeLessThan(
          queryCallOrderOf(TOUCH_LEAD_SQL),
        );
      }
      expect(eligibilityMock).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });
});

import { HttpException, Logger } from '@nestjs/common';
import { DataSource, FindOperator } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from '../common/image-url';
import { PRIVATE_PARAMETERS_COMMENT } from '../database/private-parameters-logger';
import { MediaCropService } from '../media-crops/media-crops.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole } from '../users/entities/user.entity';
import type { CulturalGuideSectionRecord } from './cultural-production.constants';
import type { CulturalCaller } from './cultural-response';
import {
  CULTURAL_STAFF_ELIGIBLE_SQL,
  culturalStaffEligibility,
  type CulturalStaffEligibility,
} from './cultural-staff-eligibility';
import {
  CULTURAL_TASK_ORDER_SQL,
  readCulturalStaffSummaries,
  readCulturalTaskLinks,
} from './cultural-staff-read';
import {
  CULTURAL_ASSIGNED_TO_CALLER_SQL,
  CULTURAL_STAFF_CALLER_FIRST_SQL,
  CULTURAL_STAFF_SEARCH_SQL,
  CULTURAL_TASK_IS_DUE_SQL,
  CULTURAL_TASK_IS_OPEN_SQL,
  CULTURAL_TRANSACTION_START_SQL,
  CULTURAL_UNASSIGNED_SQL,
  CulturalTasksService,
  TOUCH_CULTURAL_TASK_SQL,
} from './cultural-tasks.service';
import type {
  AssignCulturalTaskDto,
  CreateCulturalTaskBatchDto,
  CreateCulturalTaskDto,
  UpdateCulturalTaskDto,
} from './dto/cultural-production.dto';
import { CulturalGuide } from './entities/cultural-guide.entity';
import { CulturalIdea } from './entities/cultural-idea.entity';
import { CulturalTaskAssignee } from './entities/cultural-task-assignee.entity';
import { CulturalTask } from './entities/cultural-task.entity';

jest.mock('./cultural-staff-eligibility', () => ({
  ...jest.requireActual<object>('./cultural-staff-eligibility'),
  culturalStaffEligibility: jest.fn(),
}));

jest.mock('./cultural-staff-read', () => ({
  ...jest.requireActual<object>('./cultural-staff-read'),
  readCulturalTaskLinks: jest.fn(),
  readCulturalStaffSummaries: jest.fn(),
}));

const eligibilityMock = culturalStaffEligibility as jest.MockedFunction<
  typeof culturalStaffEligibility
>;
const taskLinksMock = readCulturalTaskLinks as jest.MockedFunction<
  typeof readCulturalTaskLinks
>;
const staffSummariesMock = readCulturalStaffSummaries as jest.MockedFunction<
  typeof readCulturalStaffSummaries
>;

const CALLER_ID = 'c0100000-0000-4000-8000-00000000000a';
const TARGET_ID = 'c0100000-0000-4000-8000-000000000002';
const OTHER_STAFF_ID = 'c0100000-0000-4000-8000-000000000003';
const SUSPENDED_ID = 'c0100000-0000-4000-8000-000000000004';
const TASK_ID = 'c0100000-0000-4000-8000-000000000011';
const IDEA_ID = 'c0100000-0000-4000-8000-000000000021';
const GUIDE_ID = 'c0100000-0000-4000-8000-000000000031';

const MEMBER_CALLER: CulturalCaller = {
  userId: CALLER_ID,
  role: UserRole.Member,
};

const TASK_TITLE = 'Book the upstairs bar';
const GUIDE_TITLE = 'Board game night';
const START_TIME = new Date('2026-11-20T10:00:00.000Z');
const FIXED_NOW = new Date('2026-11-20T09:00:00.000Z');

// A well-formed storage key: `toImageUrl` drops anything that does not parse
// as one.
const AVATAR_KEY =
  'persona/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg';

/** The text the page id builder answers from `getQueryAndParameters`. */
const PAGE_FILTER_SQL =
  'SELECT "task"."id" AS "id" FROM "cultural_tasks" "task" WHERE page-filters';

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
  groupBy: jest.Mock;
  getRawMany: jest.Mock;
  getCount: jest.Mock;
  getQueryAndParameters: jest.Mock;
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

function taskEntity(overrides: Partial<CulturalTask> = {}): CulturalTask {
  return Object.assign(new CulturalTask(), {
    id: TASK_ID,
    title: TASK_TITLE,
    notes: '',
    status: 'todo',
    dueOn: null,
    eventOn: null,
    ideaId: null,
    guideId: null,
    authorId: CALLER_ID,
    completedAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  });
}

/** The ids an `In(...)` where clause asks for. */
function idsOfWhere(options: unknown): string[] {
  const where = (options as { where: { id: FindOperator<string[]> } }).where;
  return where.id.value;
}

function guideSections(): CulturalGuideSectionRecord[] {
  return [
    {
      id: 'a0000000-0000-4000-8000-000000000001',
      heading: 'Weeks before',
      body: '',
      steps: [
        {
          id: 'b0000000-0000-4000-8000-000000000001',
          text: 'Book the venue',
          daysBefore: 14,
        },
        {
          id: 'b0000000-0000-4000-8000-000000000002',
          text: 'Buy snacks',
          daysBefore: 1,
        },
      ],
    },
    {
      id: 'a0000000-0000-4000-8000-000000000002',
      heading: 'Notes',
      body: 'No steps here',
      steps: [],
    },
    {
      id: 'a0000000-0000-4000-8000-000000000003',
      heading: 'After the event',
      body: '',
      steps: [
        {
          id: 'b0000000-0000-4000-8000-000000000003',
          text: 'Thank the volunteers',
          daysBefore: -1,
        },
        {
          id: 'b0000000-0000-4000-8000-000000000004',
          text: 'Share the photos',
          daysBefore: null,
        },
      ],
    },
  ];
}

describe('CulturalTasksService', () => {
  let manager: {
    query: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: { manager: typeof manager; transaction: jest.Mock };
  let notifications: { create: jest.Mock };
  let mediaCropService: { getMany: jest.Mock };
  let service: CulturalTasksService;
  let warnSpy: jest.SpyInstance;
  let builders: QueryBuilderStub[];
  let pickerRows: PickerRow[];
  let pageIdRows: { id: string }[];
  let statusCountRows: { status: string; count: number | string }[];
  let dueCountValue: number;
  /** Every task row the fake table holds, inserts included. */
  let taskTable: CulturalTask[];
  let storedIdea: Pick<CulturalIdea, 'id'> | null;
  let storedGuide: Pick<CulturalGuide, 'id' | 'title' | 'sections'> | null;
  let storedAssignee: Pick<CulturalTaskAssignee, 'userId'> | null;
  let assigneeCount: number;
  let isInTransaction: boolean;
  /** Every `findOne` call, with whether it ran inside a transaction. */
  let findOneLog: { entity: unknown; isInTransaction: boolean }[];
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
      'groupBy',
    ];
    for (const methodName of chainable) {
      stub[methodName] = jest.fn(() => stub);
    }
    stub.getRawMany = jest.fn(() =>
      Promise.resolve(
        builders.indexOf(stub) === 0 ? pickerRows : statusCountRows,
      ),
    );
    stub.getCount = jest.fn(() => Promise.resolve(dueCountValue));
    stub.getQueryAndParameters = jest.fn(() => [
      PAGE_FILTER_SQL,
      ['bound-parameter'],
    ]);
    return stub;
  }

  function builderAt(index: number): QueryBuilderStub {
    const stub = builders[index];
    if (!stub) {
      throw new Error(`Query builder ${index} was never created`);
    }
    return stub;
  }

  function mockEligibility(result: CulturalStaffEligibility): void {
    eligibilityMock.mockResolvedValue(result);
  }

  function insertCallsOf(entity: unknown): unknown[] {
    return manager.insert.mock.calls
      .filter((call: unknown[]) => call[0] === entity)
      .map((call: unknown[]) => call[1]);
  }

  function insertedTaskRows(): Record<string, unknown>[] {
    return insertCallsOf(CulturalTask).flatMap((rows) =>
      Array.isArray(rows)
        ? (rows as Record<string, unknown>[])
        : [rows as Record<string, unknown>],
    );
  }

  function insertedAssigneeRows(): Record<string, unknown>[] {
    return insertCallsOf(CulturalTaskAssignee).flatMap((rows) =>
      Array.isArray(rows)
        ? (rows as Record<string, unknown>[])
        : [rows as Record<string, unknown>],
    );
  }

  function hasTouched(): boolean {
    return manager.query.mock.calls.some(
      (call: unknown[]) => call[0] === TOUCH_CULTURAL_TASK_SQL,
    );
  }

  beforeEach(() => {
    setImageUrlBase('https://api.test');
    eligibilityMock.mockReset();
    mockEligibility({ kind: 'eligible' });
    taskLinksMock.mockReset();
    taskLinksMock.mockImplementation((_manager, taskIds) =>
      Promise.resolve(
        new Map(
          taskIds.map((taskId) => [
            taskId,
            { assigneeIds: [], idea: null, guide: null },
          ]),
        ),
      ),
    );
    staffSummariesMock.mockReset();
    staffSummariesMock.mockResolvedValue(new Map());
    builders = [];
    pickerRows = [];
    pageIdRows = [];
    statusCountRows = [];
    dueCountValue = 0;
    taskTable = [taskEntity()];
    storedIdea = { id: IDEA_ID };
    storedGuide = {
      id: GUIDE_ID,
      title: GUIDE_TITLE,
      sections: guideSections(),
    };
    storedAssignee = null;
    assigneeCount = 0;
    isInTransaction = false;
    findOneLog = [];
    transactionSettled = jest.fn();
    manager = {
      query: jest.fn((sql: string) => {
        if (sql === CULTURAL_TRANSACTION_START_SQL) {
          return Promise.resolve([{ started_at: START_TIME }]);
        }
        if (sql.startsWith(PAGE_FILTER_SQL)) {
          return Promise.resolve(pageIdRows);
        }
        return Promise.resolve([]);
      }),
      findOne: jest.fn((entity: unknown, options: unknown) => {
        findOneLog.push({ entity, isInTransaction });
        if (entity === CulturalTask) {
          const wantedId = (options as { where: { id: string } }).where.id;
          return Promise.resolve(
            taskTable.find((task) => task.id === wantedId) ?? null,
          );
        }
        if (entity === CulturalIdea) return Promise.resolve(storedIdea);
        if (entity === CulturalGuide) return Promise.resolve(storedGuide);
        if (entity === CulturalTaskAssignee) {
          return Promise.resolve(storedAssignee);
        }
        return Promise.resolve(null);
      }),
      find: jest.fn((entity: unknown, options: unknown) => {
        if (entity !== CulturalTask) return Promise.resolve([]);
        const wantedIds = idsOfWhere(options);
        // Answer in reverse table order, so a test proves the service sorts.
        return Promise.resolve(
          [...taskTable]
            .reverse()
            .filter((task) => wantedIds.includes(task.id)),
        );
      }),
      count: jest.fn(() => Promise.resolve(assigneeCount)),
      insert: jest.fn((entity: unknown, rows: unknown) => {
        if (entity === CulturalTask) {
          const rowList = (Array.isArray(rows) ? rows : [rows]) as Record<
            string,
            unknown
          >[];
          for (const row of rowList) {
            taskTable.push(
              taskEntity({
                ...(row as Partial<CulturalTask>),
                completedAt:
                  typeof row.completedAt === 'function' ? FIXED_NOW : null,
                createdAt:
                  row.createdAt instanceof Date ? row.createdAt : FIXED_NOW,
              }),
            );
          }
        }
        return Promise.resolve({ identifiers: [] });
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => {
        const stub = buildQueryBuilder();
        builders.push(stub);
        return stub;
      }),
    };
    dataSource = {
      manager,
      transaction: jest.fn(
        async (work: (transactionManager: typeof manager) => unknown) => {
          isInTransaction = true;
          try {
            const result = await work(manager);
            transactionSettled();
            return result;
          } finally {
            isInTransaction = false;
          }
        },
      ),
    };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    service = new CulturalTasksService(
      dataSource as unknown as DataSource,
      notifications as unknown as NotificationsService,
      mediaCropService as unknown as MediaCropService,
    );
  });

  afterEach(() => {
    warnSpy.mockRestore();
    resetImageUrlBaseForTesting();
  });

  describe('searchStaff', () => {
    it('previews five eligible staff with the caller first', async () => {
      pickerRows = [
        pickerRow({
          user_id: CALLER_ID,
          slug: 'ana-caller',
          first_name: 'Ana',
          last_name: 'Caller',
          avatar_url: null,
        }),
        pickerRow({ email: 'rui@example.test' }),
      ];

      const result = await service.searchStaff('   ', MEMBER_CALLER);

      const builder = builderAt(0);
      expect(manager.createQueryBuilder).toHaveBeenCalledWith(User, 'staff');
      expect(builder.innerJoin).toHaveBeenCalledWith(
        Profile,
        'profile',
        '"profile"."user_id" = "staff"."id"',
      );
      expect(builder.where).toHaveBeenCalledWith(CULTURAL_STAFF_ELIGIBLE_SQL);
      expect(builder.andWhere).not.toHaveBeenCalled();
      expect(builder.orderBy).toHaveBeenCalledWith(
        CULTURAL_STAFF_CALLER_FIRST_SQL,
        'ASC',
      );
      expect(builder.setParameter).toHaveBeenCalledWith('callerId', CALLER_ID);
      expect(builder.addOrderBy.mock.calls).toEqual([
        ['lower("profile"."first_name")', 'ASC'],
        ['lower("profile"."last_name")', 'ASC'],
        ['staff.id', 'ASC'],
      ]);
      expect(builder.limit).toHaveBeenCalledWith(5);
      expect(builder.select).toHaveBeenCalledWith('staff.id', 'user_id');
      expect(builder.addSelect.mock.calls).toEqual([
        ['profile.slug', 'slug'],
        ['profile.firstName', 'first_name'],
        ['profile.lastName', 'last_name'],
        ['profile.avatarUrl', 'avatar_url'],
        ['profile.photoVisible', 'photo_visible'],
      ]);
      expect(result.items).toEqual([
        {
          id: CALLER_ID,
          slug: 'ana-caller',
          displayName: 'Ana Caller',
          avatarUrl: null,
          avatarCrop: null,
        },
        {
          id: OTHER_STAFF_ID,
          slug: 'rui-staff',
          displayName: 'Rui Staff',
          avatarUrl: toImageUrl(AVATAR_KEY),
          avatarCrop: null,
        },
      ]);
      for (const item of result.items) {
        expect(Object.keys(item).sort()).toEqual([
          'avatarCrop',
          'avatarUrl',
          'displayName',
          'id',
          'slug',
        ]);
      }
      expect(mediaCropService.getMany).toHaveBeenCalledWith([AVATAR_KEY]);
    });

    it('searches twenty by folded name and keeps the text out of the query log', async () => {
      await service.searchStaff(' Ana_% ', MEMBER_CALLER);

      const builder = builderAt(0);
      expect(builder.andWhere).toHaveBeenCalledWith(CULTURAL_STAFF_SEARCH_SQL, {
        term: '%Ana\\_\\%%',
      });
      expect(builder.orderBy).toHaveBeenCalledWith(
        'lower("profile"."first_name")',
        'ASC',
      );
      expect(builder.orderBy).not.toHaveBeenCalledWith(
        CULTURAL_STAFF_CALLER_FIRST_SQL,
        'ASC',
      );
      expect(builder.limit).toHaveBeenCalledWith(20);
      expect(builder.comment).toHaveBeenCalledTimes(1);
      expect(builder.comment).toHaveBeenCalledWith(PRIVATE_PARAMETERS_COMMENT);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('dueCount', () => {
    it('counts the badge with the assigned-to-me predicate and the Lisbon day', async () => {
      dueCountValue = 3;

      const result = await service.dueCount(
        MEMBER_CALLER,
        new Date('2026-11-20T23:30:00Z'),
      );

      expect(result).toEqual({ count: 3 });
      const badgeBuilder = builderAt(0);
      expect(manager.createQueryBuilder).toHaveBeenCalledWith(
        CulturalTask,
        'task',
      );
      expect(badgeBuilder.setParameter).toHaveBeenCalledWith(
        'today',
        '2026-11-20',
      );
      expect(badgeBuilder.where).toHaveBeenCalledWith(CULTURAL_TASK_IS_DUE_SQL);
      expect(badgeBuilder.andWhere).toHaveBeenCalledWith(
        CULTURAL_ASSIGNED_TO_CALLER_SQL,
        { callerId: CALLER_ID },
      );
      expect(CULTURAL_TASK_IS_DUE_SQL).toBe(
        `"task"."status" IN ('todo', 'doing') AND "task"."due_on" <= CAST(:today AS date)`,
      );

      // The list's Assigned to me view reads the same predicate.
      await service.listTasks({ assignedTo: 'me' }, MEMBER_CALLER);
      expect(builderAt(1).andWhere).toHaveBeenCalledWith(
        CULTURAL_ASSIGNED_TO_CALLER_SQL,
        { callerId: CALLER_ID },
      );

      // Lisbon summer time is UTC+1, so 23:30 UTC is already the next day.
      await service.dueCount(MEMBER_CALLER, new Date('2026-07-20T23:30:00Z'));
      expect(builderAt(builders.length - 1).setParameter).toHaveBeenCalledWith(
        'today',
        '2026-07-21',
      );
    });
  });

  describe('listTasks', () => {
    it('orders open tasks by due day, nulls last, then done tasks by completion', async () => {
      const firstId = 'c0100000-0000-4000-8000-0000000000a1';
      const secondId = 'c0100000-0000-4000-8000-0000000000a2';
      const thirdId = 'c0100000-0000-4000-8000-0000000000a3';
      taskTable = [
        taskEntity({ id: firstId, dueOn: '2026-11-21' }),
        taskEntity({ id: secondId, dueOn: null }),
        taskEntity({
          id: thirdId,
          status: 'done',
          completedAt: FIXED_NOW,
        }),
      ];
      pageIdRows = [{ id: firstId }, { id: secondId }, { id: thirdId }];

      const result = await service.listTasks({}, MEMBER_CALLER);

      expect(manager.query).toHaveBeenCalledWith(
        `${PAGE_FILTER_SQL} ${CULTURAL_TASK_ORDER_SQL} LIMIT $2`,
        ['bound-parameter', 501],
      );
      expect(CULTURAL_TASK_ORDER_SQL).toBe(
        `ORDER BY CASE WHEN "task"."status" = 'done' THEN 1 ELSE 0 END, CASE WHEN "task"."status" = 'done' THEN NULL ELSE "task"."due_on" END ASC NULLS LAST, "task"."completed_at" DESC NULLS LAST, "task"."created_at" ASC, "task"."id" ASC`,
      );
      expect(result.items.map((item) => item.id)).toEqual([
        firstId,
        secondId,
        thirdId,
      ]);
      expect(result.isTruncated).toBe(false);
      expect(taskLinksMock).toHaveBeenCalledTimes(1);
      expect(staffSummariesMock).toHaveBeenCalledTimes(1);

      pageIdRows = Array.from({ length: 501 }, (_unused, index) => ({
        id: `c0100000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      }));
      const truncated = await service.listTasks({}, MEMBER_CALLER);
      expect(truncated.isTruncated).toBe(true);
      const findOptions = (manager.find.mock.calls as unknown[][]).at(-1)?.[1];
      expect(idsOfWhere(findOptions)).toHaveLength(500);
    });

    it('counts todo, doing and done under assignedTo alone', async () => {
      statusCountRows = [
        { status: 'todo', count: '4' },
        { status: 'done', count: 2 },
      ];

      const result = await service.listTasks(
        { assignedTo: 'me', status: 'done' },
        MEMBER_CALLER,
      );

      expect(result.counts).toEqual({ todo: 4, doing: 0, done: 2 });
      const pageBuilder = builderAt(0);
      const countBuilder = builderAt(1);
      expect(pageBuilder.andWhere).toHaveBeenCalledWith(
        '"task"."status" = :status',
        { status: 'done' },
      );
      expect(countBuilder.andWhere.mock.calls).toEqual([
        [CULTURAL_ASSIGNED_TO_CALLER_SQL, { callerId: CALLER_ID }],
      ]);
      expect(countBuilder.groupBy).toHaveBeenCalledWith('"task"."status"');

      builders = [];
      await service.listTasks(
        { assignedTo: 'unassigned', status: 'open' },
        MEMBER_CALLER,
      );
      expect(builderAt(0).andWhere.mock.calls).toEqual([
        [CULTURAL_UNASSIGNED_SQL],
        [CULTURAL_TASK_IS_OPEN_SQL],
      ]);
      expect(builderAt(1).andWhere.mock.calls).toEqual([
        [CULTURAL_UNASSIGNED_SQL],
      ]);
    });

    it('refuses an unknown assignedTo before the status', async () => {
      expect(
        await codeOf(
          service.listTasks(
            { assignedTo: 'them', status: 'nope' },
            MEMBER_CALLER,
          ),
        ),
      ).toMatchObject({ code: 'CULTURAL_ASSIGNED_TO_INVALID', status: 400 });
      expect(
        await codeOf(service.listTasks({ status: 'nope' }, MEMBER_CALLER)),
      ).toMatchObject({ code: 'CULTURAL_TASK_STATUS_INVALID', status: 400 });
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('createTask', () => {
    it('checks linked idea and guide existence inside the transaction', async () => {
      storedIdea = null;
      expect(
        await codeOf(
          service.createTask(
            { title: 'Print flyers', ideaId: IDEA_ID, guideId: GUIDE_ID },
            MEMBER_CALLER,
          ),
        ),
      ).toMatchObject({ code: 'CULTURAL_LINKED_IDEA_NOT_FOUND', status: 400 });

      storedIdea = { id: IDEA_ID };
      storedGuide = null;
      expect(
        await codeOf(
          service.createTask(
            { title: 'Print flyers', ideaId: IDEA_ID, guideId: GUIDE_ID },
            MEMBER_CALLER,
          ),
        ),
      ).toMatchObject({
        code: 'CULTURAL_LINKED_GUIDE_NOT_FOUND',
        status: 400,
      });
      expect(manager.insert).not.toHaveBeenCalled();

      const linkReads = findOneLog.filter(
        (entry) =>
          entry.entity === CulturalIdea || entry.entity === CulturalGuide,
      );
      expect(linkReads).toHaveLength(3);
      expect(linkReads.every((entry) => entry.isInTransaction)).toBe(true);
      expect(manager.findOne).toHaveBeenCalledWith(CulturalIdea, {
        where: { id: IDEA_ID },
        select: { id: true },
        lock: { mode: 'for_key_share' },
      });
    });

    it('refuses the whole create when one assignee is suspended, naming that user', async () => {
      const suspended: CulturalStaffEligibility = {
        kind: 'ineligible',
        reason: 'suspended',
      };
      const eligible: CulturalStaffEligibility = { kind: 'eligible' };
      eligibilityMock.mockImplementation((_manager, userId) =>
        Promise.resolve(userId === SUSPENDED_ID ? suspended : eligible),
      );

      const outcome = await codeOf(
        service.createTask(
          { title: 'Print flyers', assigneeIds: [TARGET_ID, SUSPENDED_ID] },
          MEMBER_CALLER,
        ),
      );

      expect(outcome).toMatchObject({
        code: 'CULTURAL_ASSIGNEE_NOT_STAFF',
        status: 400,
      });
      expect(outcome.body).toMatchObject({
        reason: 'suspended',
        userId: SUSPENDED_ID,
      });
      expect(eligibilityMock.mock.calls.map((call) => call[1])).toEqual([
        TARGET_ID,
        SUSPENDED_ID,
      ]);
      expect(manager.insert).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('sets completed_at for a task created done', async () => {
      await service.createTask(
        { title: 'Print flyers', status: 'done' },
        MEMBER_CALLER,
      );
      await service.createTask({ title: 'Hang flyers' }, MEMBER_CALLER);

      const [doneRow, todoRow] = insertedTaskRows();
      expect(doneRow?.status).toBe('done');
      const completedAt = doneRow?.completedAt as () => string;
      expect(typeof completedAt).toBe('function');
      expect(completedAt()).toBe('now()');
      expect(todoRow).toMatchObject({ status: 'todo', completedAt: null });
      expect(todoRow).toMatchObject({ authorId: CALLER_ID, eventOn: null });
    });

    it('notifies each assignee other than the caller after commit with ids and the title only', async () => {
      const result = await service.createTask(
        {
          title: `  ${TASK_TITLE}  `,
          notes: 'Ask for the side room',
          assigneeIds: [TARGET_ID, CALLER_ID.toUpperCase(), OTHER_STAFF_ID],
        },
        MEMBER_CALLER,
      );

      const [taskRow] = insertedTaskRows();
      const newTaskId = taskRow?.id as string;
      expect(result.id).toBe(newTaskId);
      expect(insertedAssigneeRows()).toEqual([
        { taskId: newTaskId, userId: TARGET_ID, assignedById: CALLER_ID },
        { taskId: newTaskId, userId: CALLER_ID, assignedById: CALLER_ID },
        { taskId: newTaskId, userId: OTHER_STAFF_ID, assignedById: CALLER_ID },
      ]);
      expect(notifications.create.mock.calls).toEqual([
        [
          TARGET_ID,
          NotificationType.CulturalTaskAssigned,
          { taskId: newTaskId, taskTitle: TASK_TITLE, assignedById: CALLER_ID },
        ],
        [
          OTHER_STAFF_ID,
          NotificationType.CulturalTaskAssigned,
          { taskId: newTaskId, taskTitle: TASK_TITLE, assignedById: CALLER_ID },
        ],
      ]);
      expect(callOrderOf(notifications.create)).toBeGreaterThan(
        callOrderOf(transactionSettled),
      );
    });
  });

  describe('updateTask', () => {
    it('sets completed_at entering done and clears it leaving done', async () => {
      await service.updateTask(TASK_ID, { status: 'done' }, MEMBER_CALLER);

      expect(manager.findOne).toHaveBeenCalledWith(CulturalTask, {
        where: { id: TASK_ID },
        lock: { mode: 'pessimistic_write' },
      });
      const enteringValues = (
        manager.update.mock.calls as unknown[][]
      )[0]?.[2] as Record<string, unknown>;
      expect(enteringValues.status).toBe('done');
      expect((enteringValues.completedAt as () => string)()).toBe('now()');

      taskTable = [taskEntity({ status: 'done', completedAt: FIXED_NOW })];
      await service.updateTask(TASK_ID, { status: 'doing' }, MEMBER_CALLER);
      expect(manager.update.mock.calls[1]).toEqual([
        CulturalTask,
        { id: TASK_ID },
        { status: 'doing', completedAt: null },
      ]);

      // Done to done changes nothing and writes nothing.
      await service.updateTask(TASK_ID, { status: 'done' }, MEMBER_CALLER);
      expect(manager.update).toHaveBeenCalledTimes(2);
    });

    it('skips the link check when the link is unchanged', async () => {
      taskTable = [taskEntity({ ideaId: IDEA_ID, guideId: GUIDE_ID })];
      storedIdea = null;
      storedGuide = null;

      await service.updateTask(
        TASK_ID,
        { title: 'Book the bar', ideaId: IDEA_ID, guideId: GUIDE_ID },
        MEMBER_CALLER,
      );

      const linkReads = findOneLog.filter(
        (entry) =>
          entry.entity === CulturalIdea || entry.entity === CulturalGuide,
      );
      expect(linkReads).toHaveLength(0);
      expect(manager.update).toHaveBeenCalledWith(
        CulturalTask,
        { id: TASK_ID },
        { title: 'Book the bar' },
      );

      const movedIdeaId = 'c0100000-0000-4000-8000-000000000022';
      expect(
        await codeOf(
          service.updateTask(TASK_ID, { ideaId: movedIdeaId }, MEMBER_CALLER),
        ),
      ).toMatchObject({ code: 'CULTURAL_LINKED_IDEA_NOT_FOUND', status: 400 });
      expect(manager.findOne).toHaveBeenCalledWith(CulturalIdea, {
        where: { id: movedIdeaId },
        select: { id: true },
        lock: { mode: 'for_key_share' },
      });
    });

    it('ignores assigneeIds on update', async () => {
      const body = {
        title: 'Book the bar',
        assigneeIds: [TARGET_ID],
      } as UpdateCulturalTaskDto;

      await service.updateTask(TASK_ID, body, MEMBER_CALLER);

      expect(manager.update).toHaveBeenCalledWith(
        CulturalTask,
        { id: TASK_ID },
        { title: 'Book the bar' },
      );
      expect(eligibilityMock).not.toHaveBeenCalled();
      expect(insertCallsOf(CulturalTaskAssignee)).toHaveLength(0);
      expect(manager.delete).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('assign', () => {
    it('checks the assign route in the contract order', async () => {
      expect(
        await codeOf(service.assign('nope', { userId: 'nope' }, MEMBER_CALLER)),
      ).toMatchObject({ code: 'CULTURAL_TASK_NOT_FOUND', status: 404 });
      for (const body of [{}, undefined, { userId: 5 }, { userId: 'nope' }]) {
        expect(
          await codeOf(
            service.assign(
              TASK_ID,
              body as unknown as AssignCulturalTaskDto,
              MEMBER_CALLER,
            ),
          ),
        ).toMatchObject({ code: 'CULTURAL_ASSIGNEE_NOT_FOUND', status: 400 });
      }
      expect(dataSource.transaction).not.toHaveBeenCalled();

      taskTable = [];
      expect(
        await codeOf(
          service.assign(TASK_ID, { userId: TARGET_ID }, MEMBER_CALLER),
        ),
      ).toMatchObject({ code: 'CULTURAL_TASK_NOT_FOUND', status: 404 });
      expect(manager.findOne).toHaveBeenCalledWith(CulturalTask, {
        where: { id: TASK_ID },
        select: { id: true, title: true },
        lock: { mode: 'pessimistic_write' },
      });
      expect(eligibilityMock).not.toHaveBeenCalled();

      taskTable = [taskEntity()];
      mockEligibility({ kind: 'not_found' });
      const notFound = await codeOf(
        service.assign(TASK_ID, { userId: TARGET_ID }, MEMBER_CALLER),
      );
      expect(notFound).toMatchObject({
        code: 'CULTURAL_ASSIGNEE_NOT_FOUND',
        status: 404,
      });
      expect(notFound.body).not.toHaveProperty('userId');

      mockEligibility({ kind: 'ineligible', reason: 'no_access' });
      const notStaff = await codeOf(
        service.assign(TASK_ID, { userId: TARGET_ID }, MEMBER_CALLER),
      );
      expect(notStaff).toMatchObject({
        code: 'CULTURAL_ASSIGNEE_NOT_STAFF',
        status: 400,
      });
      expect(notStaff.body).toMatchObject({ reason: 'no_access' });
      expect(manager.count).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('answers an existing assignment unchanged before eligibility', async () => {
      storedAssignee = { userId: TARGET_ID };

      const result = await service.assign(
        TASK_ID,
        { userId: TARGET_ID },
        MEMBER_CALLER,
      );

      expect(result.id).toBe(TASK_ID);
      expect(manager.findOne).toHaveBeenCalledWith(CulturalTaskAssignee, {
        where: { taskId: TASK_ID, userId: TARGET_ID },
        select: { userId: true },
      });
      expect(eligibilityMock).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
      expect(hasTouched()).toBe(false);
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('refuses an eleventh person with 409', async () => {
      assigneeCount = 10;

      expect(
        await codeOf(
          service.assign(TASK_ID, { userId: TARGET_ID }, MEMBER_CALLER),
        ),
      ).toMatchObject({ code: 'CULTURAL_TOO_MANY_ASSIGNEES', status: 409 });
      expect(manager.insert).not.toHaveBeenCalled();

      assigneeCount = 9;
      await service.assign(TASK_ID, { userId: TARGET_ID }, MEMBER_CALLER);
      expect(insertedAssigneeRows()).toEqual([
        { taskId: TASK_ID, userId: TARGET_ID, assignedById: CALLER_ID },
      ]);
      expect(manager.query).toHaveBeenCalledWith(TOUCH_CULTURAL_TASK_SQL, [
        TASK_ID,
      ]);
      expect(notifications.create).toHaveBeenCalledWith(
        TARGET_ID,
        NotificationType.CulturalTaskAssigned,
        { taskId: TASK_ID, taskTitle: TASK_TITLE, assignedById: CALLER_ID },
      );
      expect(callOrderOf(notifications.create)).toBeGreaterThan(
        callOrderOf(transactionSettled),
      );
    });

    it('sends nothing when the caller assigns themselves in any letter case', async () => {
      await service.assign(
        TASK_ID.toUpperCase(),
        { userId: CALLER_ID.toUpperCase() },
        MEMBER_CALLER,
      );

      expect(insertedAssigneeRows()).toEqual([
        { taskId: TASK_ID, userId: CALLER_ID, assignedById: CALLER_ID },
      ]);
      expect(eligibilityMock).toHaveBeenCalledWith(manager, CALLER_ID);
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('still answers the task when the notification fails, logging ids only', async () => {
      notifications.create.mockRejectedValue(
        new Error(`insert failed for ${TASK_TITLE}`),
      );

      const result = await service.assign(
        TASK_ID,
        { userId: TARGET_ID },
        MEMBER_CALLER,
      );

      expect(result.id).toBe(TASK_ID);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logLine = String((warnSpy.mock.calls as unknown[][])[0]?.[0]);
      expect(logLine).toContain(TASK_ID);
      expect(logLine).toContain(TARGET_ID);
      expect(logLine).toContain(CALLER_ID);
      expect(logLine).not.toContain(TASK_TITLE);
      expect(logLine).not.toContain('insert failed');
    });
  });

  describe('unassign', () => {
    it('answers 404 CULTURAL_ASSIGNEE_NOT_FOUND for a malformed user id', async () => {
      expect(
        await codeOf(service.unassign(TASK_ID, 'nope', MEMBER_CALLER)),
      ).toMatchObject({ code: 'CULTURAL_ASSIGNEE_NOT_FOUND', status: 404 });
      expect(
        await codeOf(service.unassign('nope', TARGET_ID, MEMBER_CALLER)),
      ).toMatchObject({ code: 'CULTURAL_TASK_NOT_FOUND', status: 404 });
      expect(dataSource.transaction).not.toHaveBeenCalled();

      await service.unassign(TASK_ID, TARGET_ID.toUpperCase(), MEMBER_CALLER);
      expect(manager.delete).toHaveBeenCalledWith(CulturalTaskAssignee, {
        taskId: TASK_ID,
        userId: TARGET_ID,
      });
      expect(hasTouched()).toBe(true);
      expect(eligibilityMock).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('createFromGuide', () => {
    const batchBody: CreateCulturalTaskBatchDto = {
      eventOn: '2026-12-05',
      assigneeIds: [TARGET_ID, CALLER_ID, OTHER_STAFF_ID],
    };

    it('creates one task per step in guide order with due days from the event date', async () => {
      const result = await service.createFromGuide(
        GUIDE_ID,
        batchBody,
        MEMBER_CALLER,
      );

      const taskRows = insertedTaskRows();
      expect(insertCallsOf(CulturalTask)).toHaveLength(1);
      expect(
        taskRows.map((row) => ({ title: row.title, dueOn: row.dueOn })),
      ).toEqual([
        { title: 'Book the venue', dueOn: '2026-11-21' },
        { title: 'Buy snacks', dueOn: '2026-12-04' },
        { title: 'Thank the volunteers', dueOn: '2026-12-06' },
        { title: 'Share the photos', dueOn: null },
      ]);
      for (const row of taskRows) {
        expect(row).toMatchObject({
          notes: '',
          status: 'todo',
          eventOn: '2026-12-05',
          guideId: GUIDE_ID,
          ideaId: null,
          authorId: CALLER_ID,
          completedAt: null,
        });
      }
      expect(result.items.map((item) => item.id)).toEqual(
        taskRows.map((row) => row.id),
      );
      expect(manager.findOne).toHaveBeenCalledWith(CulturalGuide, {
        where: { id: GUIDE_ID },
        select: { id: true, title: true, sections: true },
        lock: { mode: 'for_key_share' },
      });
    });

    it('assigns every listed person to every new task', async () => {
      await service.createFromGuide(GUIDE_ID, batchBody, MEMBER_CALLER);

      const taskIds = insertedTaskRows().map((row) => row.id as string);
      expect(taskIds).toHaveLength(4);
      expect(insertedAssigneeRows()).toEqual(
        taskIds.flatMap((taskId) =>
          [TARGET_ID, CALLER_ID, OTHER_STAFF_ID].map((userId) => ({
            taskId,
            userId,
            assignedById: CALLER_ID,
          })),
        ),
      );
      expect(eligibilityMock.mock.calls.map((call) => call[1])).toEqual([
        TARGET_ID,
        CALLER_ID,
        OTHER_STAFF_ID,
      ]);
    });

    it('refuses a guide with no steps', async () => {
      storedGuide = {
        id: GUIDE_ID,
        title: GUIDE_TITLE,
        sections: [
          { id: GUIDE_ID, heading: 'Only text', body: 'Read me', steps: [] },
        ],
      };

      expect(
        await codeOf(
          service.createFromGuide(GUIDE_ID, batchBody, MEMBER_CALLER),
        ),
      ).toMatchObject({ code: 'CULTURAL_GUIDE_HAS_NO_STEPS', status: 400 });
      expect(eligibilityMock).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();

      storedGuide = null;
      expect(
        await codeOf(
          service.createFromGuide(GUIDE_ID, batchBody, MEMBER_CALLER),
        ),
      ).toMatchObject({ code: 'CULTURAL_GUIDE_NOT_FOUND', status: 404 });
      expect(
        await codeOf(service.createFromGuide('nope', batchBody, MEMBER_CALLER)),
      ).toMatchObject({ code: 'CULTURAL_GUIDE_NOT_FOUND', status: 404 });
      expect(
        await codeOf(
          service.createFromGuide(
            GUIDE_ID,
            { eventOn: '2026-02-30' },
            MEMBER_CALLER,
          ),
        ),
      ).toMatchObject({ code: 'CULTURAL_EVENT_DATE_INVALID', status: 400 });
    });

    it('sends one batch notification per assignee other than the caller', async () => {
      await service.createFromGuide(GUIDE_ID, batchBody, MEMBER_CALLER);

      expect(notifications.create.mock.calls).toEqual([
        [
          TARGET_ID,
          NotificationType.CulturalTaskBatchAssigned,
          {
            guideId: GUIDE_ID,
            guideTitle: GUIDE_TITLE,
            taskCount: 4,
            assignedById: CALLER_ID,
          },
        ],
        [
          OTHER_STAFF_ID,
          NotificationType.CulturalTaskBatchAssigned,
          {
            guideId: GUIDE_ID,
            guideTitle: GUIDE_TITLE,
            taskCount: 4,
            assignedById: CALLER_ID,
          },
        ],
      ]);
      expect(callOrderOf(notifications.create)).toBeGreaterThan(
        callOrderOf(transactionSettled),
      );
    });

    it('staggers created_at by step position', async () => {
      await service.createFromGuide(GUIDE_ID, batchBody, MEMBER_CALLER);

      expect(manager.query).toHaveBeenCalledWith(
        CULTURAL_TRANSACTION_START_SQL,
      );
      const createdTimes = insertedTaskRows().map((row) =>
        (row.createdAt as Date).getTime(),
      );
      const startMilliseconds = START_TIME.getTime();
      expect(createdTimes).toEqual([
        startMilliseconds,
        startMilliseconds + 1,
        startMilliseconds + 2,
        startMilliseconds + 3,
      ]);
    });
  });

  describe('deleteTask', () => {
    it('refuses delete by another member with CULTURAL_TASK_NOT_YOURS', async () => {
      taskTable = [taskEntity({ authorId: TARGET_ID })];

      expect(
        await codeOf(service.deleteTask(TASK_ID, MEMBER_CALLER)),
      ).toMatchObject({ code: 'CULTURAL_TASK_NOT_YOURS', status: 403 });
      expect(manager.delete).not.toHaveBeenCalled();

      expect(
        await service.deleteTask(TASK_ID, {
          userId: CALLER_ID,
          role: UserRole.Moderator,
        }),
      ).toEqual({ ok: true });
      expect(manager.delete).toHaveBeenCalledWith(CulturalTask, {
        id: TASK_ID,
      });
    });
  });

  it('creates a task without a body list and answers it with notes', async () => {
    const body: CreateCulturalTaskDto = {
      title: 'Print flyers',
      notes: 'Two hundred copies',
    };

    const result = await service.createTask(body, MEMBER_CALLER);

    expect(result.notes).toBe('Two hundred copies');
    expect(insertCallsOf(CulturalTaskAssignee)).toHaveLength(0);
    expect(notifications.create).not.toHaveBeenCalled();
  });
});

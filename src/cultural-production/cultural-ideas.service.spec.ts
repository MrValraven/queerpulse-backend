import { HttpException, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import {
  CULTURAL_IDEA_BACK_SQL,
  CULTURAL_IDEA_BACKER_STATS_SQL,
  CULTURAL_IDEA_COMMENT_COUNTS_SQL,
  CULTURAL_IDEA_LINKED_TASK_IDS_SQL,
  CULTURAL_IDEA_TASK_COUNTS_SQL,
  CULTURAL_IDEA_UNBACK_SQL,
  CulturalIdeasService,
} from './cultural-ideas.service';
import type { CulturalCaller } from './cultural-response';
import { CULTURAL_TASK_ORDER_SQL } from './cultural-staff-read';
import { CulturalIdeaBacker } from './entities/cultural-idea-backer.entity';
import { CulturalIdeaComment } from './entities/cultural-idea-comment.entity';
import { CulturalIdea } from './entities/cultural-idea.entity';
import { CulturalTask } from './entities/cultural-task.entity';

const AUTHOR_ID = 'c9100000-0000-4000-8000-000000000001';
const OTHER_MEMBER_ID = 'c9100000-0000-4000-8000-000000000002';
const MODERATOR_ID = 'c9100000-0000-4000-8000-000000000003';
const IDEA_ID = 'c9100000-0000-4000-8000-000000000011';
const OTHER_IDEA_ID = 'c9100000-0000-4000-8000-000000000012';
const COMMENT_ID = 'c9100000-0000-4000-8000-000000000021';
const NEW_COMMENT_ID = 'c9100000-0000-4000-8000-000000000022';
const FIRST_TASK_ID = 'c9100000-0000-4000-8000-000000000031';
const SECOND_TASK_ID = 'c9100000-0000-4000-8000-000000000032';
const SECRET_TITLE = 'Secret drag brunch plan';
const SECRET_COMMENT = 'Ask the venue about the back garden';

const AUTHOR: CulturalCaller = { userId: AUTHOR_ID, role: UserRole.Member };
const OTHER_MEMBER: CulturalCaller = {
  userId: OTHER_MEMBER_ID,
  role: UserRole.Member,
};
const MODERATOR: CulturalCaller = {
  userId: MODERATOR_ID,
  role: UserRole.Moderator,
};

interface RefusalOutcome {
  code?: string;
  status?: number;
}

async function refusalOf(promise: Promise<unknown>): Promise<RefusalOutcome> {
  try {
    await promise;
    return {};
  } catch (error) {
    const httpError = error as HttpException;
    const body = httpError.getResponse() as Record<string, unknown>;
    return {
      code: body.code as string | undefined,
      status: httpError.getStatus(),
    };
  }
}

/** A v4 uuid for the idea at a list position. */
function ideaIdAt(position: number): string {
  return `c9100000-0000-4000-8000-${String(1000 + position).padStart(12, '0')}`;
}

function buildIdea(overrides: Partial<CulturalIdea> = {}): CulturalIdea {
  return {
    id: IDEA_ID,
    title: SECRET_TITLE,
    description: '',
    eventType: 'board_game_night',
    status: 'new',
    authorId: AUTHOR_ID,
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    updatedAt: new Date('2026-11-02T10:00:00.000Z'),
    ...overrides,
  };
}

function buildComment(
  overrides: Partial<CulturalIdeaComment> = {},
): CulturalIdeaComment {
  return {
    id: COMMENT_ID,
    ideaId: IDEA_ID,
    authorId: AUTHOR_ID,
    body: 'First thought',
    createdAt: new Date('2026-11-03T10:00:00.000Z'),
    ...overrides,
  };
}

function buildTask(overrides: Partial<CulturalTask> = {}): CulturalTask {
  return {
    id: FIRST_TASK_ID,
    title: 'Book the venue',
    notes: '',
    status: 'todo',
    dueOn: '2026-12-01',
    eventOn: null,
    ideaId: IDEA_ID,
    guideId: null,
    authorId: AUTHOR_ID,
    completedAt: null,
    createdAt: new Date('2026-11-04T10:00:00.000Z'),
    updatedAt: new Date('2026-11-04T10:00:00.000Z'),
    ...overrides,
  };
}

describe('CulturalIdeasService', () => {
  let manager: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock; manager: typeof manager };
  let mediaCropService: { getMany: jest.Mock };
  let service: CulturalIdeasService;
  let storedIdeas: CulturalIdea[];
  let storedIdea: CulturalIdea | null;
  let storedBackers: CulturalIdeaBacker[];
  let storedComments: CulturalIdeaComment[];
  let storedTasks: CulturalTask[];
  let linkedTaskIdRows: { id: string }[];
  let backerStatsRows: Record<string, unknown>[];
  let commentCountRows: Record<string, unknown>[];
  let taskCountRows: Record<string, unknown>[];

  /** Every `manager.query` call whose SQL is the given text. */
  function queryCallsOf(sql: string): unknown[][] {
    return (manager.query.mock.calls as unknown[][]).filter(
      (call: unknown[]) => call[0] === sql,
    );
  }

  /** Every `manager.find` call on the given entity. */
  function findCallsOf(entity: unknown): unknown[][] {
    return (manager.find.mock.calls as unknown[][]).filter(
      (call: unknown[]) => call[0] === entity,
    );
  }

  /** Whether any data access ran on the fakes. */
  function hasTouchedTheDatabase(): boolean {
    return (
      dataSource.transaction.mock.calls.length > 0 ||
      Object.values(manager).some((method) => method.mock.calls.length > 0)
    );
  }

  beforeEach(() => {
    storedIdeas = [];
    storedIdea = buildIdea();
    storedBackers = [];
    storedComments = [];
    storedTasks = [];
    linkedTaskIdRows = [];
    backerStatsRows = [];
    commentCountRows = [];
    taskCountRows = [];
    manager = {
      find: jest.fn((entity: unknown) => {
        if (entity === CulturalIdea) return Promise.resolve(storedIdeas);
        if (entity === CulturalIdeaBacker) {
          return Promise.resolve(storedBackers);
        }
        if (entity === CulturalIdeaComment) {
          return Promise.resolve(storedComments);
        }
        if (entity === CulturalTask) return Promise.resolve(storedTasks);
        if (entity === Profile) return Promise.resolve([]);
        return Promise.resolve([]);
      }),
      findOne: jest.fn(
        (entity: unknown, options: { where?: Record<string, unknown> }) => {
          const where = options.where ?? {};
          if (entity === CulturalIdea) {
            return Promise.resolve(
              storedIdea && storedIdea.id === where.id ? storedIdea : null,
            );
          }
          if (entity === CulturalIdeaComment) {
            const comment = storedComments.find(
              (candidate) =>
                candidate.id === where.id && candidate.ideaId === where.ideaId,
            );
            return Promise.resolve(comment ?? null);
          }
          return Promise.resolve(null);
        },
      ),
      create: jest.fn((_entity: unknown, row: object) => ({ ...row })),
      save: jest.fn((entity: unknown, row: Record<string, unknown>) => {
        if (entity === CulturalIdea) {
          storedIdea = buildIdea({
            ...(row as Partial<CulturalIdea>),
            id: IDEA_ID,
          });
          return Promise.resolve(storedIdea);
        }
        if (entity === CulturalIdeaComment) {
          const comment = buildComment({
            ...(row as Partial<CulturalIdeaComment>),
            id: NEW_COMMENT_ID,
            createdAt: new Date('2026-11-05T10:00:00.000Z'),
          });
          storedComments = [...storedComments, comment];
          return Promise.resolve(comment);
        }
        return Promise.resolve(row);
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      // Answers by SQL text; every other statement gets an empty list.
      query: jest.fn((sql: string) => {
        if (sql === CULTURAL_IDEA_BACKER_STATS_SQL) {
          return Promise.resolve(backerStatsRows);
        }
        if (sql === CULTURAL_IDEA_COMMENT_COUNTS_SQL) {
          return Promise.resolve(commentCountRows);
        }
        if (sql === CULTURAL_IDEA_TASK_COUNTS_SQL) {
          return Promise.resolve(taskCountRows);
        }
        if (sql === CULTURAL_IDEA_LINKED_TASK_IDS_SQL) {
          return Promise.resolve(linkedTaskIdRows);
        }
        return Promise.resolve([]);
      }),
    };
    dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
      manager,
    };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
    service = new CulturalIdeasService(
      dataSource as unknown as DataSource,
      mediaCropService as unknown as MediaCropService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lists newest first and flags a 501st idea as truncated', async () => {
    storedIdeas = Array.from({ length: 501 }, (_unused, position) =>
      buildIdea({ id: ideaIdAt(position) }),
    );

    const list = await service.listIdeas(AUTHOR);

    expect(findCallsOf(CulturalIdea)).toEqual([
      [CulturalIdea, { order: { createdAt: 'DESC', id: 'DESC' }, take: 501 }],
    ]);
    expect(list.isTruncated).toBe(true);
    expect(list.items).toHaveLength(500);
    expect(list.items[0]?.id).toBe(ideaIdAt(0));
    expect(list.items[499]?.id).toBe(ideaIdAt(499));
  });

  it('reads backers, comment counts and task counts in grouped queries', async () => {
    const backerIds = Array.from(
      { length: 5 },
      (_unused, position) =>
        `c9100000-0000-4000-8000-${String(2000 + position).padStart(12, '0')}`,
    );
    backerStatsRows = [
      {
        idea_id: ideaIdAt(0),
        backer_count: '7',
        backer_ids: backerIds,
        is_backed_by_me: true,
      },
    ];
    commentCountRows = [{ idea_id: ideaIdAt(0), comment_count: '3' }];
    taskCountRows = [
      {
        idea_id: ideaIdAt(0),
        linked_task_count: '4',
        open_linked_task_count: '1',
      },
    ];

    const queryCountFor = async (ideaCount: number): Promise<number> => {
      storedIdeas = Array.from({ length: ideaCount }, (_unused, position) =>
        buildIdea({ id: ideaIdAt(position) }),
      );
      manager.query.mockClear();
      manager.find.mockClear();
      await service.listIdeas(AUTHOR);
      expect(findCallsOf(Profile)).toHaveLength(1);
      return manager.query.mock.calls.length;
    };

    expect(await queryCountFor(2)).toBe(3);
    expect(await queryCountFor(40)).toBe(3);

    const pageIds = storedIdeas.map((idea) => idea.id);
    expect(queryCallsOf(CULTURAL_IDEA_BACKER_STATS_SQL)).toEqual([
      [CULTURAL_IDEA_BACKER_STATS_SQL, [pageIds, AUTHOR_ID]],
    ]);
    expect(queryCallsOf(CULTURAL_IDEA_COMMENT_COUNTS_SQL)).toEqual([
      [CULTURAL_IDEA_COMMENT_COUNTS_SQL, [pageIds]],
    ]);
    expect(queryCallsOf(CULTURAL_IDEA_TASK_COUNTS_SQL)).toEqual([
      [CULTURAL_IDEA_TASK_COUNTS_SQL, [pageIds]],
    ]);
    expect(CULTURAL_IDEA_BACKER_STATS_SQL).toContain('GROUP BY');
    expect(CULTURAL_IDEA_COMMENT_COUNTS_SQL).toContain('GROUP BY');
    expect(CULTURAL_IDEA_TASK_COUNTS_SQL).toContain(
      `FILTER (WHERE "task"."status" IN ('todo', 'doing'))`,
    );

    const list = await service.listIdeas(AUTHOR);
    const first = list.items[0];
    expect(first?.backers.map((backer) => backer.id)).toEqual(backerIds);
    expect(first?.backerCount).toBe(7);
    expect(first?.isBackedByMe).toBe(true);
    expect(first?.commentCount).toBe(3);
    expect(first?.linkedTaskCount).toBe(4);
    expect(first?.openLinkedTaskCount).toBe(1);
    const second = list.items[1];
    expect(second?.backers).toEqual([]);
    expect(second?.backerCount).toBe(0);
    expect(second?.isBackedByMe).toBe(false);
    expect(second?.commentCount).toBe(0);
    expect(second?.linkedTaskCount).toBe(0);
  });

  it('answers CULTURAL_IDEA_NOT_FOUND for a malformed id before any query', async () => {
    const malformedId = 'not-a-uuid';
    const attempts: Promise<unknown>[] = [
      service.getIdea(malformedId, AUTHOR),
      service.updateIdea(malformedId, { title: 'New' }, AUTHOR),
      service.deleteIdea(malformedId, AUTHOR),
      service.backIdea(malformedId, AUTHOR),
      service.unbackIdea(malformedId, AUTHOR),
      service.addComment(malformedId, { body: 'Hi' }, AUTHOR),
      service.deleteComment(malformedId, COMMENT_ID, AUTHOR),
    ];

    for (const attempt of attempts) {
      expect(await refusalOf(attempt)).toEqual({
        code: 'CULTURAL_IDEA_NOT_FOUND',
        status: 404,
      });
    }
    expect(hasTouchedTheDatabase()).toBe(false);
  });

  it('creates with status new by default and the caller as author', async () => {
    const idea = await service.createIdea(
      { title: `  ${SECRET_TITLE}  `, eventType: 'quiz_night' },
      AUTHOR,
    );

    expect(manager.save).toHaveBeenCalledWith(CulturalIdea, {
      title: SECRET_TITLE,
      description: '',
      eventType: 'quiz_night',
      status: 'new',
      authorId: AUTHOR_ID,
    });
    expect(idea.status).toBe('new');
    expect(idea.author?.id).toBe(AUTHOR_ID);
    expect(idea.canDelete).toBe(true);
  });

  it('answers the idea unchanged for an empty update', async () => {
    const idea = await service.updateIdea(
      IDEA_ID,
      { unknownField: 1 } as never,
      AUTHOR,
    );

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(idea.id).toBe(IDEA_ID);
    expect(idea.title).toBe(SECRET_TITLE);
    expect(idea.updatedAt).toBe('2026-11-02T10:00:00.000Z');
  });

  it('writes only the fields that changed on an update', async () => {
    await service.updateIdea(
      IDEA_ID,
      { title: SECRET_TITLE, status: 'planned' },
      AUTHOR,
    );

    expect(manager.update).toHaveBeenCalledWith(
      CulturalIdea,
      { id: IDEA_ID },
      { status: 'planned' },
    );
  });

  it('refuses delete by another member with CULTURAL_IDEA_NOT_YOURS', async () => {
    expect(await refusalOf(service.deleteIdea(IDEA_ID, OTHER_MEMBER))).toEqual({
      code: 'CULTURAL_IDEA_NOT_YOURS',
      status: 403,
    });
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('lets a moderator delete any idea', async () => {
    expect(await service.deleteIdea(IDEA_ID, MODERATOR)).toEqual({ ok: true });
    expect(manager.delete).toHaveBeenCalledWith(CulturalIdea, { id: IDEA_ID });
  });

  it('backs idempotently and leaves updated_at alone', async () => {
    const firstAnswer = await service.backIdea(IDEA_ID, OTHER_MEMBER);
    const secondAnswer = await service.backIdea(IDEA_ID, OTHER_MEMBER);

    expect(queryCallsOf(CULTURAL_IDEA_BACK_SQL)).toEqual([
      [CULTURAL_IDEA_BACK_SQL, [IDEA_ID, OTHER_MEMBER_ID]],
      [CULTURAL_IDEA_BACK_SQL, [IDEA_ID, OTHER_MEMBER_ID]],
    ]);
    expect(CULTURAL_IDEA_BACK_SQL).toContain('ON CONFLICT DO NOTHING');
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(firstAnswer.updatedAt).toBe('2026-11-02T10:00:00.000Z');
    expect(secondAnswer.updatedAt).toBe('2026-11-02T10:00:00.000Z');

    await service.unbackIdea(IDEA_ID, OTHER_MEMBER);
    expect(queryCallsOf(CULTURAL_IDEA_UNBACK_SQL)).toEqual([
      [CULTURAL_IDEA_UNBACK_SQL, [IDEA_ID, OTHER_MEMBER_ID]],
    ]);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('answers CULTURAL_COMMENT_EMPTY for a body that is no object', async () => {
    for (const body of [null, 'Hi', 7]) {
      expect(
        await refusalOf(
          service.addComment(
            IDEA_ID,
            body as unknown as { body?: unknown },
            AUTHOR,
          ),
        ),
      ).toEqual({ code: 'CULTURAL_COMMENT_EMPTY', status: 400 });
    }
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('posts a comment and answers the idea with it last', async () => {
    storedComments = [buildComment()];

    const idea = await service.addComment(
      IDEA_ID,
      { body: `\r\n${SECRET_COMMENT}\r\n` },
      OTHER_MEMBER,
    );

    expect(manager.save).toHaveBeenCalledWith(CulturalIdeaComment, {
      ideaId: IDEA_ID,
      authorId: OTHER_MEMBER_ID,
      body: SECRET_COMMENT,
    });
    expect(findCallsOf(CulturalIdeaComment)).toEqual([
      [
        CulturalIdeaComment,
        { where: { ideaId: IDEA_ID }, order: { createdAt: 'ASC', id: 'ASC' } },
      ],
    ]);
    expect(idea.comments.map((comment) => comment.id)).toEqual([
      COMMENT_ID,
      NEW_COMMENT_ID,
    ]);
    expect(idea.comments[1]?.body).toBe(SECRET_COMMENT);
    expect(idea.comments[1]?.canDelete).toBe(true);
    expect(idea.commentCount).toBe(2);
  });

  it('answers CULTURAL_COMMENT_NOT_FOUND for a comment of another idea', async () => {
    storedComments = [buildComment({ ideaId: OTHER_IDEA_ID })];

    expect(
      await refusalOf(service.deleteComment(IDEA_ID, COMMENT_ID, MODERATOR)),
    ).toEqual({ code: 'CULTURAL_COMMENT_NOT_FOUND', status: 404 });
    expect(
      await refusalOf(service.deleteComment(IDEA_ID, 'nope', MODERATOR)),
    ).toEqual({ code: 'CULTURAL_COMMENT_NOT_FOUND', status: 404 });
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('answers the linked tasks in the shared task order', async () => {
    storedTasks = [
      buildTask({ id: FIRST_TASK_ID }),
      buildTask({ id: SECOND_TASK_ID, status: 'done' }),
    ];
    linkedTaskIdRows = [{ id: SECOND_TASK_ID }, { id: FIRST_TASK_ID }];

    const idea = await service.getIdea(IDEA_ID.toUpperCase(), AUTHOR);

    expect(
      CULTURAL_IDEA_LINKED_TASK_IDS_SQL.endsWith(CULTURAL_TASK_ORDER_SQL),
    ).toBe(true);
    expect(queryCallsOf(CULTURAL_IDEA_LINKED_TASK_IDS_SQL)).toEqual([
      [CULTURAL_IDEA_LINKED_TASK_IDS_SQL, [IDEA_ID]],
    ]);
    expect(idea.linkedTasks.map((task) => task.id)).toEqual([
      SECOND_TASK_ID,
      FIRST_TASK_ID,
    ]);
    expect(idea.linkedTaskCount).toBe(2);
    expect(idea.openLinkedTaskCount).toBe(1);
  });

  it('logs ids only', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    storedComments = [buildComment({ body: SECRET_COMMENT })];

    await service.createIdea(
      { title: SECRET_TITLE, description: SECRET_COMMENT, eventType: 'talk' },
      AUTHOR,
    );
    await service.addComment(IDEA_ID, { body: SECRET_COMMENT }, AUTHOR);
    await service.deleteComment(IDEA_ID, COMMENT_ID, AUTHOR);
    await service.deleteIdea(IDEA_ID, AUTHOR);

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.includes(AUTHOR_ID))).toBe(true);
    expect(lines.every((line) => line.includes(IDEA_ID))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(SECRET_TITLE);
      expect(line).not.toContain(SECRET_COMMENT);
    }
  });
});

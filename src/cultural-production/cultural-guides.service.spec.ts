import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import type { CulturalGuideSectionRecord } from './cultural-production.constants';
import type { CulturalCaller } from './cultural-response';
import {
  CulturalGuidesService,
  REPLACE_CULTURAL_GUIDE_SQL,
} from './cultural-guides.service';
import { CulturalGuide } from './entities/cultural-guide.entity';
import { CulturalTask } from './entities/cultural-task.entity';

const AUTHOR_ID = 'c5100000-0000-4000-8000-000000000001';
const EDITOR_ID = 'c5100000-0000-4000-8000-000000000002';
const MODERATOR_ID = 'c5100000-0000-4000-8000-000000000003';
const GUIDE_ID = 'c5100000-0000-4000-8000-000000000011';
const SECOND_GUIDE_ID = 'c5100000-0000-4000-8000-000000000012';
const SECTION_ID = 'c5100000-0000-4000-8000-000000000021';
const STEP_ID = 'c5100000-0000-4000-8000-000000000031';
const SECOND_STEP_ID = 'c5100000-0000-4000-8000-000000000032';

const AUTHOR: CulturalCaller = { userId: AUTHOR_ID, role: UserRole.Member };
const EDITOR: CulturalCaller = { userId: EDITOR_ID, role: UserRole.Member };
const MODERATOR: CulturalCaller = {
  userId: MODERATOR_ID,
  role: UserRole.Moderator,
};

const STORED_SECTIONS: CulturalGuideSectionRecord[] = [
  {
    id: SECTION_ID,
    heading: 'Before the night',
    body: 'Pick the games.',
    steps: [
      { id: STEP_ID, text: 'Book the venue', daysBefore: 14 },
      { id: SECOND_STEP_ID, text: 'Buy snacks', daysBefore: 1 },
    ],
  },
];

interface RefusalOutcome {
  code?: string;
  status?: number;
  body?: Record<string, unknown>;
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
      body,
    };
  }
}

function buildGuide(overrides: Partial<CulturalGuide> = {}): CulturalGuide {
  return Object.assign(new CulturalGuide(), {
    id: GUIDE_ID,
    title: 'Board game night',
    eventType: 'board_game_night',
    locale: 'en',
    summary: 'How we run a board game night.',
    sections: STORED_SECTIONS,
    revision: 3,
    authorId: AUTHOR_ID,
    updatedById: null,
    createdAt: new Date('2026-11-01T10:00:00Z'),
    updatedAt: new Date('2026-11-02T10:00:00Z'),
    ...overrides,
  });
}

function buildProfile(userId: string, firstName: string): Profile {
  return Object.assign(new Profile(), {
    userId,
    slug: firstName.toLowerCase(),
    firstName,
    lastName: 'Silva',
    avatarUrl: null,
    photoVisible: true,
  });
}

/** A replace body from `revision` with every required field. */
function replaceBody(overrides: Record<string, unknown> = {}) {
  return {
    revision: 3,
    title: '  Board game night, longer  ',
    eventType: 'board_game_night',
    locale: 'en',
    summary: 'Updated summary',
    sections: [
      {
        id: SECTION_ID,
        heading: 'Before the night',
        body: 'Pick the games.',
        steps: [{ id: STEP_ID, text: 'Book the venue', daysBefore: 14 }],
      },
    ],
    ...overrides,
  };
}

describe('CulturalGuidesService', () => {
  let manager: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock; manager: typeof manager };
  let mediaCropService: { getMany: jest.Mock };
  let service: CulturalGuidesService;
  let storedGuide: CulturalGuide | null;
  let listedGuides: CulturalGuide[];
  let storedProfiles: Profile[];

  /** The calls of `manager.query` that ran the guarded replace. */
  function replaceCalls(): unknown[][] {
    const calls = manager.query.mock.calls as unknown[][];
    return calls.filter((call) => call[0] === REPLACE_CULTURAL_GUIDE_SQL);
  }

  beforeEach(() => {
    storedGuide = buildGuide();
    listedGuides = [];
    storedProfiles = [];
    manager = {
      find: jest.fn((entity: unknown) => {
        if (entity === CulturalGuide) return Promise.resolve(listedGuides);
        if (entity === Profile) return Promise.resolve(storedProfiles);
        return Promise.resolve([]);
      }),
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(entity === CulturalGuide ? storedGuide : null),
      ),
      create: jest.fn((_entity: unknown, row: object) => ({ ...row })),
      save: jest.fn((_entity: unknown, row: Partial<CulturalGuide>) => {
        storedGuide = buildGuide({ ...row, id: SECOND_GUIDE_ID });
        return Promise.resolve(storedGuide);
      }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      // The guarded replace answers one row while the stored revision matches,
      // and bumps the stored guide the way the UPDATE does.
      query: jest.fn((sql: string, parameters: unknown[]) => {
        if (sql !== REPLACE_CULTURAL_GUIDE_SQL) return Promise.resolve([]);
        if (!storedGuide || storedGuide.revision !== parameters[1]) {
          return Promise.resolve([]);
        }
        storedGuide = buildGuide({
          ...storedGuide,
          title: parameters[2] as string,
          summary: parameters[5] as string,
          sections: JSON.parse(
            parameters[6] as string,
          ) as CulturalGuideSectionRecord[],
          revision: storedGuide.revision + 1,
          updatedById: parameters[7] as string,
        });
        return Promise.resolve([{ id: storedGuide.id }]);
      }),
    };
    dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
      manager,
    };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
    service = new CulturalGuidesService(
      dataSource as unknown as DataSource,
      mediaCropService as unknown as MediaCropService,
    );
  });

  describe('listGuides', () => {
    it('lists guides by event type, locale and title without sections', async () => {
      listedGuides = [
        buildGuide({ updatedById: EDITOR_ID }),
        buildGuide({
          id: SECOND_GUIDE_ID,
          eventType: 'quiz_night',
          title: 'Quiz night',
          authorId: null,
          sections: [],
        }),
      ];
      storedProfiles = [
        buildProfile(AUTHOR_ID, 'Ana'),
        buildProfile(EDITOR_ID, 'Rui'),
      ];

      const answer = await service.listGuides(EDITOR);

      expect(manager.find).toHaveBeenCalledWith(CulturalGuide, {
        order: { eventType: 'ASC', locale: 'ASC', title: 'ASC', id: 'ASC' },
      });
      const findOrder = (
        manager.find.mock.calls[0] as [unknown, { order: object }]
      )[1].order;
      expect(Object.keys(findOrder)).toEqual([
        'eventType',
        'locale',
        'title',
        'id',
      ]);
      expect(answer.items.map((item) => item.id)).toEqual([
        GUIDE_ID,
        SECOND_GUIDE_ID,
      ]);
      for (const item of answer.items) {
        expect(item).not.toHaveProperty('sections');
        expect(item).not.toHaveProperty('revision');
      }
      const [first, second] = answer.items;
      expect(first).toMatchObject({
        sectionCount: 1,
        stepCount: 2,
        author: { id: AUTHOR_ID, displayName: 'Ana Silva' },
        updatedBy: { id: EDITOR_ID, displayName: 'Rui Silva' },
        canDelete: false,
      });
      expect(second).toMatchObject({
        sectionCount: 0,
        stepCount: 0,
        author: null,
        updatedBy: null,
        canDelete: false,
      });
      // Every person on the page comes from one profiles read.
      const profileReads = manager.find.mock.calls.filter(
        (call: unknown[]) => call[0] === Profile,
      );
      expect(profileReads).toHaveLength(1);
    });
  });

  describe('createGuide', () => {
    it('creates a guide with revision 1 and the caller as author', async () => {
      const answer = await service.createGuide(
        {
          title: '  Quiz night  ',
          eventType: 'quiz_night',
          locale: 'pt',
        },
        AUTHOR,
      );

      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledWith(CulturalGuide, {
        title: 'Quiz night',
        eventType: 'quiz_night',
        locale: 'pt',
        summary: '',
        sections: [],
        revision: 1,
        authorId: AUTHOR_ID,
        updatedById: null,
      });
      expect(answer).toMatchObject({
        id: SECOND_GUIDE_ID,
        title: 'Quiz night',
        revision: 1,
        author: { id: AUTHOR_ID },
        updatedBy: null,
        sections: [],
        canDelete: true,
      });
    });

    it('runs the field checks before any write', async () => {
      const outcome = await refusalOf(
        service.createGuide(
          { title: 'Quiz night', eventType: 'quiz_night', locale: 'fr' },
          AUTHOR,
        ),
      );

      expect(outcome).toMatchObject({
        code: 'CULTURAL_GUIDE_LOCALE_INVALID',
        status: 400,
      });
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('replaceGuide', () => {
    it('replaces the guide and bumps the revision and updated_by', async () => {
      storedProfiles = [buildProfile(EDITOR_ID, 'Rui')];

      const answer = await service.replaceGuide(
        GUIDE_ID.toUpperCase(),
        replaceBody(),
        EDITOR,
      );

      expect(replaceCalls()).toEqual([
        [
          REPLACE_CULTURAL_GUIDE_SQL,
          [
            GUIDE_ID,
            3,
            'Board game night, longer',
            'board_game_night',
            'en',
            'Updated summary',
            JSON.stringify([
              {
                id: SECTION_ID,
                heading: 'Before the night',
                body: 'Pick the games.',
                steps: [
                  { id: STEP_ID, text: 'Book the venue', daysBefore: 14 },
                ],
              },
            ]),
            EDITOR_ID,
          ],
        ],
      ]);
      expect(REPLACE_CULTURAL_GUIDE_SQL).toContain(
        '"revision" = "revision" + 1',
      );
      expect(REPLACE_CULTURAL_GUIDE_SQL).toContain(
        '"updated_by_id" = $8::uuid',
      );
      expect(REPLACE_CULTURAL_GUIDE_SQL).toContain(
        'WHERE "id" = $1::uuid AND "revision" = $2::int',
      );
      expect(answer).toMatchObject({
        id: GUIDE_ID,
        title: 'Board game night, longer',
        revision: 4,
        author: { id: AUTHOR_ID },
        updatedBy: { id: EDITOR_ID, displayName: 'Rui Silva' },
        sectionCount: 1,
        stepCount: 1,
      });
    });

    it('answers CULTURAL_GUIDE_EDIT_CONFLICT with the current revision when the revision moved', async () => {
      storedGuide = buildGuide({ revision: 5, updatedById: AUTHOR_ID });

      const outcome = await refusalOf(
        service.replaceGuide(GUIDE_ID, replaceBody({ revision: 3 }), EDITOR),
      );

      expect(outcome.status).toBe(409);
      expect(outcome.body).toEqual({
        statusCode: 409,
        message: 'Someone saved this guide after you opened it.',
        code: 'CULTURAL_GUIDE_EDIT_CONFLICT',
        revision: 5,
      });
      expect(replaceCalls()).toHaveLength(1);
      // The stored guide is untouched: the second save wrote nothing.
      expect(storedGuide).toMatchObject({
        revision: 5,
        updatedById: AUTHOR_ID,
        title: 'Board game night',
      });
    });

    it('lets only the first of two saves from one revision through', async () => {
      await service.replaceGuide(GUIDE_ID, replaceBody(), AUTHOR);
      const outcome = await refusalOf(
        service.replaceGuide(GUIDE_ID, replaceBody(), EDITOR),
      );

      expect(outcome).toMatchObject({
        code: 'CULTURAL_GUIDE_EDIT_CONFLICT',
        status: 409,
        body: { revision: 4 },
      });
      expect(storedGuide).toMatchObject({
        revision: 4,
        updatedById: AUTHOR_ID,
      });
    });

    it('answers CULTURAL_GUIDE_NOT_FOUND when the guide is gone', async () => {
      storedGuide = null;

      const outcome = await refusalOf(
        service.replaceGuide(GUIDE_ID, replaceBody(), EDITOR),
      );

      expect(outcome).toMatchObject({
        code: 'CULTURAL_GUIDE_NOT_FOUND',
        status: 404,
      });
      expect(outcome.body).not.toHaveProperty('revision');
      expect(replaceCalls()).toHaveLength(1);
    });

    it('answers CULTURAL_GUIDE_NOT_FOUND for a malformed id before any query', async () => {
      const outcome = await refusalOf(
        service.replaceGuide('not-a-uuid', replaceBody(), EDITOR),
      );

      expect(outcome).toMatchObject({
        code: 'CULTURAL_GUIDE_NOT_FOUND',
        status: 404,
      });
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('checks revision before title on replace', async () => {
      const missingRevision = await refusalOf(
        service.replaceGuide(
          GUIDE_ID,
          replaceBody({ revision: undefined, title: '' }),
          EDITOR,
        ),
      );
      const zeroRevision = await refusalOf(
        service.replaceGuide(
          GUIDE_ID,
          replaceBody({ revision: 0, title: '' }),
          EDITOR,
        ),
      );
      const blankTitle = await refusalOf(
        service.replaceGuide(
          GUIDE_ID,
          replaceBody({ revision: 3, title: '   ' }),
          EDITOR,
        ),
      );

      expect(missingRevision.code).toBe('CULTURAL_GUIDE_REVISION_INVALID');
      expect(zeroRevision.code).toBe('CULTURAL_GUIDE_REVISION_INVALID');
      expect(blankTitle.code).toBe('CULTURAL_TITLE_REQUIRED');
      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  describe('getGuide', () => {
    it('answers the whole guide with its sections and revision', async () => {
      const answer = await service.getGuide(GUIDE_ID, EDITOR);

      expect(answer.revision).toBe(3);
      expect(answer.sections).toEqual(STORED_SECTIONS);
      expect(answer.canDelete).toBe(false);
    });

    it('answers CULTURAL_GUIDE_NOT_FOUND for a missing guide', async () => {
      storedGuide = null;

      const outcome = await refusalOf(service.getGuide(GUIDE_ID, EDITOR));

      expect(outcome).toMatchObject({
        code: 'CULTURAL_GUIDE_NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('deleteGuide', () => {
    it('lets only the staff tier delete a seeded guide', async () => {
      storedGuide = buildGuide({ authorId: null });

      const grantHolderOutcome = await refusalOf(
        service.deleteGuide(GUIDE_ID, AUTHOR),
      );

      expect(grantHolderOutcome).toMatchObject({
        code: 'CULTURAL_GUIDE_NOT_YOURS',
        status: 403,
      });
      expect(manager.delete).not.toHaveBeenCalled();

      await expect(service.deleteGuide(GUIDE_ID, MODERATOR)).resolves.toEqual({
        ok: true,
      });
      expect(manager.delete).toHaveBeenCalledWith(CulturalGuide, {
        id: GUIDE_ID,
      });
    });

    it('lets the author delete their guide and refuses another member', async () => {
      const otherOutcome = await refusalOf(
        service.deleteGuide(GUIDE_ID, EDITOR),
      );
      expect(otherOutcome.code).toBe('CULTURAL_GUIDE_NOT_YOURS');

      await expect(service.deleteGuide(GUIDE_ID, AUTHOR)).resolves.toEqual({
        ok: true,
      });
    });

    it('answers CULTURAL_GUIDE_NOT_FOUND before the permission', async () => {
      storedGuide = null;

      const outcome = await refusalOf(service.deleteGuide(GUIDE_ID, EDITOR));

      expect(outcome).toMatchObject({
        code: 'CULTURAL_GUIDE_NOT_FOUND',
        status: 404,
      });
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('keeps tasks when a guide is deleted', async () => {
      await service.deleteGuide(GUIDE_ID, AUTHOR);

      expect(manager.delete).toHaveBeenCalledTimes(1);
      expect(manager.delete).toHaveBeenCalledWith(CulturalGuide, {
        id: GUIDE_ID,
      });
      const taskDeletes = manager.delete.mock.calls.filter(
        (call: unknown[]) => call[0] === CulturalTask,
      );
      expect(taskDeletes).toHaveLength(0);
      const taskStatements = manager.query.mock.calls.filter(
        (call: unknown[]) => String(call[0]).includes('cultural_tasks'),
      );
      expect(taskStatements).toHaveLength(0);
    });
  });
});

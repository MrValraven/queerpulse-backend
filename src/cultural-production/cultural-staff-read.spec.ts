import { In, type EntityManager } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import type { MediaCropService } from '../media-crops/media-crops.service';
import { Profile } from '../users/entities/profile.entity';
import {
  CULTURAL_TASK_ASSIGNEE_IDS_SQL,
  CULTURAL_TASK_GUIDE_TITLES_SQL,
  CULTURAL_TASK_IDEA_TITLES_SQL,
  CULTURAL_TASK_ORDER_SQL,
  readCulturalStaffSummaries,
  readCulturalTaskLinks,
} from './cultural-staff-read';

const API_BASE_URL = 'https://api.example.test';
const SHOWN_AVATAR_KEY =
  'persona/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg';
const HIDDEN_AVATAR_KEY =
  'persona/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.jpg';
const SHOWN_CROP: CropRect = {
  x: 0.1,
  y: 0.1,
  width: 0.5,
  height: 0.5,
  aspect: '1:1',
};

const FIRST_ID = '6f1c2a40-8b3d-4e5f-9a10-1b2c3d4e5f60';
const SECOND_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const MISSING_ID = '8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
const TASK_ONE = '9c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f';
const TASK_TWO = 'ad4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a';
const IDEA_ID = 'cf5a6b7c-8d9e-4f0a-9b1c-4d5e6f7a8b9c';
const GUIDE_ID = 'de6b7c8d-9e0f-4a1b-8c2d-5e6f7a8b9c0d';

function profileOf(overrides: Partial<Profile>): Profile {
  return {
    userId: FIRST_ID,
    slug: 'ana-silva',
    firstName: 'Ana',
    lastName: 'Silva',
    avatarUrl: SHOWN_AVATAR_KEY,
    photoVisible: true,
    ...overrides,
  } as Profile;
}

function mediaCropsMock(): { getMany: jest.Mock } {
  return {
    getMany: jest
      .fn()
      .mockResolvedValue(new Map([[SHOWN_AVATAR_KEY, SHOWN_CROP]])),
  };
}

describe('readCulturalStaffSummaries', () => {
  beforeEach(() => {
    setImageUrlBase(API_BASE_URL);
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('reads the distinct ids in one profile query and one crop batch', async () => {
    const find = jest.fn().mockResolvedValue([
      profileOf({}),
      profileOf({
        userId: SECOND_ID,
        slug: 'rui-costa',
        firstName: 'Rui',
        lastName: 'Costa',
        avatarUrl: HIDDEN_AVATAR_KEY,
        photoVisible: false,
      }),
    ]);
    const manager = { find } as unknown as EntityManager;
    const mediaCrops = mediaCropsMock();

    const summaries = await readCulturalStaffSummaries(
      manager,
      mediaCrops as unknown as MediaCropService,
      [FIRST_ID, SECOND_ID, FIRST_ID, MISSING_ID, SECOND_ID],
    );

    expect(find).toHaveBeenCalledTimes(1);
    const [entity, options] = find.mock.calls[0] as [
      unknown,
      { where: { userId: unknown } },
    ];
    expect(entity).toBe(Profile);
    expect(options.where.userId).toEqual(In([FIRST_ID, SECOND_ID, MISSING_ID]));
    expect(mediaCrops.getMany).toHaveBeenCalledTimes(1);
    expect(mediaCrops.getMany).toHaveBeenCalledWith([SHOWN_AVATAR_KEY]);
    expect([...summaries.keys()]).toEqual([FIRST_ID, SECOND_ID, MISSING_ID]);
    expect(summaries.get(FIRST_ID)).toEqual({
      id: FIRST_ID,
      slug: 'ana-silva',
      displayName: 'Ana Silva',
      avatarUrl: toImageUrl(SHOWN_AVATAR_KEY),
      avatarCrop: SHOWN_CROP,
    });
    expect(summaries.get(SECOND_ID)).toEqual({
      id: SECOND_ID,
      slug: 'rui-costa',
      displayName: 'Rui Costa',
      avatarUrl: null,
      avatarCrop: null,
    });
    expect(summaries.get(MISSING_ID)).toEqual({
      id: MISSING_ID,
      slug: '',
      displayName: '',
      avatarUrl: null,
      avatarCrop: null,
    });
  });

  it('selects six columns', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const manager = { find } as unknown as EntityManager;

    await readCulturalStaffSummaries(
      manager,
      mediaCropsMock() as unknown as MediaCropService,
      [FIRST_ID],
    );

    const [, options] = find.mock.calls[0] as [
      unknown,
      { select: Record<string, boolean> },
    ];
    expect(options.select).toEqual({
      userId: true,
      slug: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
      photoVisible: true,
    });
    expect(Object.keys(options.select)).toHaveLength(6);
  });

  it('reads nothing for no ids', async () => {
    const find = jest.fn();
    const mediaCrops = mediaCropsMock();

    const summaries = await readCulturalStaffSummaries(
      { find } as unknown as EntityManager,
      mediaCrops as unknown as MediaCropService,
      [],
    );

    expect(summaries.size).toBe(0);
    expect(find).not.toHaveBeenCalled();
    expect(mediaCrops.getMany).not.toHaveBeenCalled();
  });
});

describe('readCulturalTaskLinks', () => {
  it('reads assignees, idea titles and guide titles in three queries', async () => {
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(
      (sql: string) => {
        if (sql === CULTURAL_TASK_ASSIGNEE_IDS_SQL) {
          return Promise.resolve([
            { task_id: TASK_ONE, user_id: SECOND_ID },
            { task_id: TASK_ONE, user_id: FIRST_ID },
          ]);
        }
        if (sql === CULTURAL_TASK_IDEA_TITLES_SQL) {
          return Promise.resolve([
            { task_id: TASK_ONE, idea_id: IDEA_ID, title: 'Quiz in spring' },
          ]);
        }
        if (sql === CULTURAL_TASK_GUIDE_TITLES_SQL) {
          return Promise.resolve([
            { task_id: TASK_TWO, guide_id: GUIDE_ID, title: 'Quiz night' },
          ]);
        }
        return Promise.reject(new Error('unexpected query'));
      },
    );
    const manager = { query } as unknown as EntityManager;

    const links = await readCulturalTaskLinks(manager, [
      TASK_ONE,
      TASK_TWO,
      TASK_ONE,
    ]);

    expect(query).toHaveBeenCalledTimes(3);
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual([[TASK_ONE, TASK_TWO]]);
    }
    expect(links.get(TASK_ONE)).toEqual({
      assigneeIds: [SECOND_ID, FIRST_ID],
      idea: { id: IDEA_ID, title: 'Quiz in spring' },
      guide: null,
    });
    expect(links.get(TASK_TWO)).toEqual({
      assigneeIds: [],
      idea: null,
      guide: { id: GUIDE_ID, title: 'Quiz night' },
    });
  });

  it('orders the assignee query by assigned_at then user_id over an id array', () => {
    expect(CULTURAL_TASK_ASSIGNEE_IDS_SQL).toContain('= ANY($1::uuid[])');
    expect(CULTURAL_TASK_ASSIGNEE_IDS_SQL).toMatch(
      /ORDER BY "assignee"\."assigned_at" ASC, "assignee"\."user_id" ASC$/,
    );
  });

  it('reads nothing for no task ids', async () => {
    const query = jest.fn();
    const links = await readCulturalTaskLinks(
      { query } as unknown as EntityManager,
      [],
    );
    expect(links.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('CULTURAL_TASK_ORDER_SQL', () => {
  it('holds the contract task order over the task alias', () => {
    expect(CULTURAL_TASK_ORDER_SQL).toBe(
      `ORDER BY CASE WHEN "task"."status" = 'done' THEN 1 ELSE 0 END, CASE WHEN "task"."status" = 'done' THEN NULL ELSE "task"."due_on" END ASC NULLS LAST, "task"."completed_at" DESC NULLS LAST, "task"."created_at" ASC, "task"."id" ASC`,
    );
  });
});

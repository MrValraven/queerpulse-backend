import { HttpException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { PersonaImageKeysService } from '../storage/persona-image-keys.service';
import { SubprofilePublicReadService } from '../subprofiles/subprofile-public-read.service';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofilePostQuotaEntry } from './entities/subprofile-post-quota-entry.entity';
import { SubprofilePost } from './entities/subprofile-post.entity';
import { PersonaPostAlertsService } from './persona-post-alerts.service';
import { encodePersonaPostCursor } from './persona-post-cursor';
import {
  PERSONA_POST_NOTIFICATIONS_DELETE_SQL,
  SubprofilePostsService,
  isUsablePostImageKey,
} from './subprofile-posts.service';

const USER_ID = 'de000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = 'de000000-0000-4000-8000-000000000009';
const PERSONA_ID = 'de000000-0000-4000-8000-000000000002';
const POST_ID = 'de000000-0000-4000-8000-000000000003';
const MEMBER_IMAGE = `persona-covers/${USER_ID}/de000000-0000-4000-8000-000000000004.jpg`;
const FOREIGN_IMAGE = `persona-covers/${OTHER_USER_ID}/de000000-0000-4000-8000-000000000005.jpg`;
const OWN_PERSONA_IMAGE = `persona/${PERSONA_ID}/de000000-0000-4000-8000-000000000006.jpg`;
const OTHER_PERSONA_IMAGE =
  'persona/de000000-0000-4000-8000-0000000000aa/de000000-0000-4000-8000-000000000007.jpg';
const FRESH_IMAGE = `persona/${PERSONA_ID}/de000000-0000-4000-8000-000000000008.jpg`;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

function pageQueryBuilder(rows: unknown[]) {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue(rows);
  return queryBuilder;
}

const postRow = (index: number, overrides: Partial<SubprofilePost> = {}) => ({
  id: `de000000-0000-4000-8000-1000000000${String(index).padStart(2, '0')}`,
  subprofileId: PERSONA_ID,
  authorUserId: USER_ID,
  body: `Post ${index}`,
  linkUrl: null,
  imageKey: null,
  createdAt: new Date(Date.UTC(2026, 9, 13, 9, 0, 60 - index)),
  editedAt: null,
  ...overrides,
});

describe('SubprofilePostsService', () => {
  let persona: Partial<Subprofile> | null;
  let isMember: boolean;
  let postsToday: number;
  let storedPost: SubprofilePost | null;
  let manager: {
    findOne: jest.Mock;
    exists: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
    delete: jest.Mock;
  };
  let posts: { createQueryBuilder: jest.Mock };
  let publicRead: { resolveReadablePersona: jest.Mock };
  let personaImageKeys: {
    findRegistration: jest.Mock;
    rehomeKeys: jest.Mock;
    forgetDeletedKeys: jest.Mock;
    deleteObjects: jest.Mock;
  };
  let alerts: { alertFollowers: jest.Mock };
  let dataSourceQuery: jest.Mock;
  let service: SubprofilePostsService;

  beforeAll(() => setImageUrlBase('https://api.test'));
  afterAll(() => resetImageUrlBaseForTesting());

  beforeEach(() => {
    persona = { id: PERSONA_ID, kind: 'dj' as Subprofile['kind'] };
    isMember = true;
    postsToday = 0;
    storedPost = postRow(1, { id: POST_ID, imageKey: OWN_PERSONA_IMAGE });
    manager = {
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(entity === Subprofile ? persona : storedPost),
      ),
      exists: jest.fn(() => Promise.resolve(isMember)),
      count: jest.fn(() => Promise.resolve(postsToday)),
      create: jest.fn((_entity: unknown, row: object) => row),
      save: jest.fn((row: object) =>
        Promise.resolve({
          id: POST_ID,
          createdAt: new Date('2026-10-13T09:00:00.000Z'),
          editedAt: null,
          ...row,
        }),
      ),
      insert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    posts = { createQueryBuilder: jest.fn(() => pageQueryBuilder([])) };
    publicRead = {
      resolveReadablePersona: jest.fn(() =>
        Promise.resolve({ persona, isOwner: false }),
      ),
    };
    personaImageKeys = {
      findRegistration: jest.fn((key: string) =>
        Promise.resolve(
          key === OWN_PERSONA_IMAGE
            ? { storageKey: key, subprofileId: PERSONA_ID }
            : key === OTHER_PERSONA_IMAGE
              ? { storageKey: key, subprofileId: 'another-persona' }
              : null,
        ),
      ),
      rehomeKeys: jest.fn((_manager: unknown, _id: string, values: string[]) =>
        Promise.resolve(new Map(values.map((value) => [value, FRESH_IMAGE]))),
      ),
      forgetDeletedKeys: jest.fn().mockResolvedValue(undefined),
      deleteObjects: jest.fn().mockResolvedValue(undefined),
    };
    alerts = { alertFollowers: jest.fn().mockResolvedValue(undefined) };
    dataSourceQuery = jest.fn().mockResolvedValue([]);
    const dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
      query: dataSourceQuery,
    };
    service = new SubprofilePostsService(
      dataSource as unknown as DataSource,
      posts as unknown as Repository<SubprofilePost>,
      publicRead as unknown as SubprofilePublicReadService,
      personaImageKeys as unknown as PersonaImageKeysService,
      alerts as unknown as PersonaPostAlertsService,
    );
  });

  describe('listPosts', () => {
    it('reads through the persona page rule and pages ten at a time, newest first', async () => {
      const rows = Array.from({ length: 11 }, (_unused, index) =>
        postRow(index + 1),
      );
      const queryBuilder = pageQueryBuilder(rows);
      posts.createQueryBuilder.mockReturnValue(queryBuilder);

      const page = await service.listPosts(undefined, PERSONA_ID);

      expect(publicRead.resolveReadablePersona).toHaveBeenCalledWith(
        PERSONA_ID,
        undefined,
      );
      expect(queryBuilder.limit).toHaveBeenCalledWith(11);
      expect(queryBuilder.orderBy).toHaveBeenCalledWith(
        'post.createdAt',
        'DESC',
      );
      expect(page.items).toHaveLength(10);
      expect(page.items.every((item) => item.canEdit === false)).toBe(true);
      expect(page.pageInfo).toEqual({
        hasMore: true,
        nextCursor: encodePersonaPostCursor({
          createdAt: rows[9]!.createdAt,
          id: rows[9]!.id,
        }),
      });
    });

    it('seeks past a cursor and marks posts editable for an owner', async () => {
      publicRead.resolveReadablePersona.mockResolvedValue({
        persona,
        isOwner: true,
      });
      const queryBuilder = pageQueryBuilder([postRow(1)]);
      posts.createQueryBuilder.mockReturnValue(queryBuilder);
      const cursor = encodePersonaPostCursor({
        createdAt: new Date('2026-10-13T08:00:00.000Z'),
        id: POST_ID,
      });

      const page = await service.listPosts(undefined, PERSONA_ID, cursor);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '("post"."created_at", "post"."id") < (:cursorCreatedAt, :cursorId)',
        {
          cursorCreatedAt: new Date('2026-10-13T08:00:00.000Z'),
          cursorId: POST_ID,
        },
      );
      expect(page.items[0]?.canEdit).toBe(true);
    });

    it('answers an empty page for a persona of another kind', async () => {
      persona = { id: PERSONA_ID, kind: 'writer' as Subprofile['kind'] };
      expect(await service.listPosts(undefined, PERSONA_ID)).toEqual({
        items: [],
        pageInfo: { nextCursor: null, hasMore: false },
      });
      expect(posts.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('lets the persona page refusal through as a 404', async () => {
      publicRead.resolveReadablePersona.mockRejectedValue(
        new NotFoundException('Persona not found'),
      );
      await expect(
        service.listPosts(undefined, PERSONA_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createPost', () => {
    it('writes the post with its author, a ledger entry and prunes the old ledger, under the persona lock', async () => {
      const post = await service.createPost(USER_ID, PERSONA_ID, {
        body: 'Out Friday',
        linkUrl: '',
      });

      expect(manager.findOne).toHaveBeenCalledWith(Subprofile, {
        where: { id: PERSONA_ID },
        lock: { mode: 'for_no_key_update' },
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          subprofileId: PERSONA_ID,
          authorUserId: USER_ID,
          body: 'Out Friday',
          linkUrl: null,
          imageKey: null,
        }),
      );
      expect(manager.insert).toHaveBeenCalledWith(SubprofilePostQuotaEntry, {
        subprofileId: PERSONA_ID,
      });
      expect(manager.delete).toHaveBeenCalledWith(
        SubprofilePostQuotaEntry,
        expect.objectContaining({ subprofileId: PERSONA_ID }),
      );
      expect(post.canEdit).toBe(true);
      expect(JSON.stringify(post)).not.toContain(USER_ID);
    });

    it('answers 404 to a member who does not run the persona, and for an unknown persona', async () => {
      isMember = false;
      await expect(
        service.createPost(USER_ID, PERSONA_ID, { body: 'Hi' }),
      ).rejects.toEqual(new NotFoundException('Persona not found'));
      persona = null;
      await expect(
        service.createPost(USER_ID, PERSONA_ID, { body: 'Hi' }),
      ).rejects.toEqual(new NotFoundException('Persona not found'));
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('answers 404 to an owner of a removed persona and writes nothing', async () => {
      persona = {
        id: PERSONA_ID,
        kind: 'dj' as Subprofile['kind'],
        removedAt: new Date('2026-10-12T09:00:00.000Z'),
      };
      await expect(
        service.createPost(USER_ID, PERSONA_ID, { body: 'Hi' }),
      ).rejects.toEqual(new NotFoundException('Persona not found'));
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
      expect(alerts.alertFollowers).not.toHaveBeenCalled();
    });

    it('refuses a persona of another kind with 422', async () => {
      persona = { id: PERSONA_ID, kind: 'writer' as Subprofile['kind'] };
      expect(
        await codeOf(service.createPost(USER_ID, PERSONA_ID, { body: 'Hi' })),
      ).toBe('persona_posts_not_available');
    });

    it('counts the quota ledger, so a deleted post still counts toward the day', async () => {
      postsToday = 10;
      expect(
        await codeOf(service.createPost(USER_ID, PERSONA_ID, { body: 'Hi' })),
      ).toBe('persona_post_daily_limit');
      const [entity, options] = manager.count.mock.calls[0] as [
        unknown,
        { where: { subprofileId: string } },
      ];
      expect(entity).toBe(SubprofilePostQuotaEntry);
      expect(options.where.subprofileId).toBe(PERSONA_ID);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('alerts only the first three posts of the day', async () => {
      postsToday = 2;
      await service.createPost(USER_ID, PERSONA_ID, { body: 'Third' });
      expect(alerts.alertFollowers).toHaveBeenCalledTimes(1);
      postsToday = 3;
      await service.createPost(USER_ID, PERSONA_ID, { body: 'Fourth' });
      expect(alerts.alertFollowers).toHaveBeenCalledTimes(1);
    });

    it('copies a photo the member uploaded to a fresh key of this persona', async () => {
      await service.createPost(USER_ID, PERSONA_ID, {
        body: 'Cover shoot',
        imageKey: MEMBER_IMAGE,
      });
      expect(personaImageKeys.rehomeKeys).toHaveBeenCalledWith(
        manager,
        PERSONA_ID,
        [MEMBER_IMAGE],
        { shouldCopyMemberScoped: true, personaScopedMode: 'copy-all' },
      );
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ imageKey: FRESH_IMAGE }),
      );
    });

    it('copies a photo of this persona, so deleting the post never deletes the original', async () => {
      await service.createPost(USER_ID, PERSONA_ID, {
        body: 'From the archive',
        imageKey: OWN_PERSONA_IMAGE,
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ imageKey: FRESH_IMAGE }),
      );
    });

    it.each([
      ['a photo of another persona', OTHER_PERSONA_IMAGE],
      ['another member upload', FOREIGN_IMAGE],
      ['an external image', 'https://images.example/x.jpg'],
    ])('refuses %s with 422', async (_label, imageKey) => {
      expect(
        await codeOf(
          service.createPost(USER_ID, PERSONA_ID, { body: 'Hi', imageKey }),
        ),
      ).toBe('persona_post_image_not_allowed');
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('updatePost', () => {
    it('edits the body, stamps the edit and never alerts', async () => {
      const post = await service.updatePost(USER_ID, POST_ID, {
        body: 'Out Friday, Lux at 23h',
      });
      const saved = manager.save.mock.calls[0]![0] as SubprofilePost;
      expect(saved.body).toBe('Out Friday, Lux at 23h');
      expect(saved.editedAt).toBeInstanceOf(Date);
      expect(post.editedAt).not.toBeNull();
      expect(alerts.alertFollowers).not.toHaveBeenCalled();
    });

    it('keeps the stored photo when imageKey is omitted', async () => {
      await service.updatePost(USER_ID, POST_ID, { body: 'New caption' });
      expect((manager.save.mock.calls[0]![0] as SubprofilePost).imageKey).toBe(
        OWN_PERSONA_IMAGE,
      );
      expect(personaImageKeys.rehomeKeys).not.toHaveBeenCalled();
      expect(personaImageKeys.forgetDeletedKeys).not.toHaveBeenCalled();
      expect(personaImageKeys.deleteObjects).not.toHaveBeenCalled();
    });

    it('replaces the photo with a fresh copy and deletes the old one', async () => {
      await service.updatePost(USER_ID, POST_ID, { imageKey: MEMBER_IMAGE });
      expect((manager.save.mock.calls[0]![0] as SubprofilePost).imageKey).toBe(
        FRESH_IMAGE,
      );
      expect(personaImageKeys.deleteObjects).toHaveBeenCalledWith([
        OWN_PERSONA_IMAGE,
      ]);
    });

    it('keeps the stored photo when it is sent back unchanged', async () => {
      await service.updatePost(USER_ID, POST_ID, {
        imageKey: OWN_PERSONA_IMAGE,
      });
      expect(personaImageKeys.rehomeKeys).not.toHaveBeenCalled();
      expect(personaImageKeys.deleteObjects).not.toHaveBeenCalled();
    });

    it.each([
      ['an empty PATCH', {}],
      ['the same body', { body: 'Post 1' }],
      ['the same body with spaces around it', { body: '  Post 1  ' }],
      ['the same link', { linkUrl: 'https://x.test' }],
      ['the stored photo key', { imageKey: OWN_PERSONA_IMAGE }],
    ])(
      'writes nothing and keeps editedAt null for %s',
      async (_label, patch) => {
        storedPost = postRow(1, {
          id: POST_ID,
          linkUrl: 'https://x.test',
          imageKey: OWN_PERSONA_IMAGE,
        });

        const post = await service.updatePost(USER_ID, POST_ID, patch);

        expect(manager.save).not.toHaveBeenCalled();
        expect(post.editedAt).toBeNull();
        expect(post).toEqual(
          expect.objectContaining({
            id: POST_ID,
            body: 'Post 1',
            linkUrl: 'https://x.test',
            canEdit: true,
          }),
        );
        expect(personaImageKeys.deleteObjects).not.toHaveBeenCalled();
      },
    );

    it('treats an empty link and null alike when no link is stored', async () => {
      await service.updatePost(USER_ID, POST_ID, { linkUrl: '' });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('stamps editedAt when the link changes', async () => {
      const post = await service.updatePost(USER_ID, POST_ID, {
        linkUrl: 'https://y.test',
      });
      const saved = manager.save.mock.calls[0]![0] as SubprofilePost;
      expect(saved.linkUrl).toBe('https://y.test');
      expect(saved.editedAt).toBeInstanceOf(Date);
      expect(post.editedAt).not.toBeNull();
    });

    it('stamps editedAt when the photo changes', async () => {
      await service.updatePost(USER_ID, POST_ID, { imageKey: null });
      expect(
        (manager.save.mock.calls[0]![0] as SubprofilePost).editedAt,
      ).toBeInstanceOf(Date);
    });

    it('clears the photo and deletes the old object after the commit', async () => {
      await service.updatePost(USER_ID, POST_ID, { imageKey: null });
      expect((manager.save.mock.calls[0]![0] as SubprofilePost).imageKey).toBe(
        null,
      );
      expect(personaImageKeys.forgetDeletedKeys).toHaveBeenCalledWith([
        OWN_PERSONA_IMAGE,
      ]);
      expect(personaImageKeys.deleteObjects).toHaveBeenCalledWith([
        OWN_PERSONA_IMAGE,
      ]);
      expect(manager.save.mock.invocationCallOrder[0]).toBeLessThan(
        personaImageKeys.deleteObjects.mock.invocationCallOrder[0]!,
      );
    });

    it('clears the link with null', async () => {
      storedPost = postRow(1, { id: POST_ID, linkUrl: 'https://x.test' });
      await service.updatePost(USER_ID, POST_ID, { linkUrl: null });
      expect(
        (manager.save.mock.calls[0]![0] as SubprofilePost).linkUrl,
      ).toBeNull();
    });

    it('answers 404 for a post the caller cannot edit, and for a missing one', async () => {
      isMember = false;
      await expect(
        service.updatePost(USER_ID, POST_ID, { body: 'x' }),
      ).rejects.toEqual(new NotFoundException('Post not found'));
      storedPost = null;
      await expect(
        service.updatePost(USER_ID, POST_ID, { body: 'x' }),
      ).rejects.toEqual(new NotFoundException('Post not found'));
    });

    it('answers 404 to an owner of a removed persona and saves nothing', async () => {
      persona = {
        id: PERSONA_ID,
        kind: 'dj' as Subprofile['kind'],
        removedAt: new Date('2026-10-12T09:00:00.000Z'),
      };
      await expect(
        service.updatePost(USER_ID, POST_ID, { body: 'x' }),
      ).rejects.toEqual(new NotFoundException('Persona not found'));
      expect(manager.save).not.toHaveBeenCalled();
      expect(personaImageKeys.deleteObjects).not.toHaveBeenCalled();
    });
  });

  describe('deletePost', () => {
    it('deletes the post and then its photo', async () => {
      await service.deletePost(USER_ID, POST_ID);
      expect(manager.delete).toHaveBeenCalledWith(SubprofilePost, {
        id: POST_ID,
      });
      expect(personaImageKeys.deleteObjects).toHaveBeenCalledWith([
        OWN_PERSONA_IMAGE,
      ]);
      expect(manager.delete.mock.invocationCallOrder[0]).toBeLessThan(
        personaImageKeys.deleteObjects.mock.invocationCallOrder[0]!,
      );
    });

    it('leaves the quota ledger alone, so the post still counts toward the day', async () => {
      await service.deletePost(USER_ID, POST_ID);
      expect(manager.delete).toHaveBeenCalledTimes(1);
      expect(manager.delete).not.toHaveBeenCalledWith(
        SubprofilePostQuotaEntry,
        expect.anything(),
      );
    });

    it('answers 404 for a post the caller cannot edit and deletes nothing', async () => {
      isMember = false;
      await expect(service.deletePost(USER_ID, POST_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(manager.delete).not.toHaveBeenCalled();
      expect(personaImageKeys.deleteObjects).not.toHaveBeenCalled();
      expect(dataSourceQuery).not.toHaveBeenCalled();
    });

    it("leaves the follower bells on an owner's delete, so they age out", async () => {
      await service.deletePost(USER_ID, POST_ID);
      expect(manager.delete).toHaveBeenCalledWith(SubprofilePost, {
        id: POST_ID,
      });
      expect(dataSourceQuery).not.toHaveBeenCalledWith(
        PERSONA_POST_NOTIFICATIONS_DELETE_SQL,
        expect.anything(),
      );
    });
  });

  it('knows an uploaded image key from anything else', () => {
    expect(isUsablePostImageKey(MEMBER_IMAGE)).toBe(true);
    expect(isUsablePostImageKey(OWN_PERSONA_IMAGE)).toBe(true);
    expect(isUsablePostImageKey('https://images.example/x.jpg')).toBe(false);
  });
});

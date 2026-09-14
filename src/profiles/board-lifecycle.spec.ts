import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindOperator } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { HandlesService } from '../handles/handles.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { StorageService } from '../storage/storage.service';
import { BlockFilterService } from '../social/block-filter.service';
import { HiddenFromService } from '../social/hidden-from.service';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Profile } from '../users/entities/profile.entity';
import { VouchService } from '../vouch/vouch.service';
import { Activity } from './entities/activity.entity';
import {
  BoardKind,
  BoardPost,
  BoardPostStatus,
} from './entities/board-post.entity';
import { BoardPostResponse } from './entities/board-post-response.entity';
import { Group } from './entities/group.entity';
import { GroupMembership } from './entities/group-membership.entity';
import { ProfileFeaturedCommunity } from './entities/profile-featured-community.entity';
import { ProfileNowHistory } from './entities/profile-now-history.entity';
import { Shaping } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import { ActivityVisibilityService } from './activity-visibility.service';
import { LastActiveService } from './last-active.service';
import { NowInsightsService } from './now-insights.service';
import { ProfilesService } from './profiles.service';

// Board-item lifecycle (Task 3 of the member-profile-v2-backend plan): status,
// closed note/timestamp, and a kind-dependent expiry. The endpoint under test,
// `PUT /profiles/me/board`, is a FULL REPLACE of the caller's ordered board
// list on every save (title/slug/position edits, reordering, add/remove) — it
// must NOT reset an item's closed/found lifecycle just because the member
// re-saved the list for an unrelated reason. These tests exercise the
// slug-matching preserve logic directly against ProfilesService.replaceBoard,
// plus the new ProfilesService.closeBoardItem.
describe('ProfilesService board lifecycle', () => {
  let service: ProfilesService;
  let boardPosts: { find: jest.Mock; findOne: jest.Mock; save: jest.Mock };
  let manager: {
    find: jest.Mock;
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let savedRows: BoardPost[];
  let dataSource: { transaction: jest.Mock };

  const USER_ID = 'user-1';
  const NOW = new Date('2026-08-18T12:00:00.000Z').getTime();

  const findEmpty = () => ({ find: jest.fn().mockResolvedValue([]) });

  beforeEach(async () => {
    savedRows = [];
    manager = {
      // The existing rows for the caller, as they stood right before the
      // replace — this is what replaceBoard matches new items against.
      find: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      // Mirrors TypeORM's EntityManager.create + `@CreateDateColumn`: when the
      // caller (replaceBoard) supplies an explicit `createdAt` (a preserved
      // slug), TypeORM inserts that value verbatim — it does not force
      // CURRENT_TIMESTAMP over a caller-provided value. Only when `createdAt`
      // is left `undefined` (a genuinely new slug) does the column default
      // apply, which we simulate as "now".
      create: jest.fn(
        (_entity: unknown, data: Partial<BoardPost>) =>
          ({
            ...data,
            createdAt: data.createdAt ?? new Date(NOW),
          }) as BoardPost,
      ),
      save: jest.fn((rows: BoardPost[]) => {
        savedRows = rows;
        return Promise.resolve(rows);
      }),
    };
    boardPosts = {
      // Read back after the transaction commits — reflects whatever the
      // transaction actually saved, exactly like the real repository would.
      find: jest.fn().mockImplementation(() => Promise.resolve(savedRows)),
      findOne: jest.fn(),
      save: jest.fn(),
    };

    // Fakes both `Date.now()` (used by replaceBoard's fresh-expiresAt calc)
    // and `new Date()` (used by closeBoardItem's closedAt) consistently.
    jest.useFakeTimers({ now: NOW });

    // Held directly (not re-fetched via `module.get(DataSource)`) so the mock
    // keeps its `jest.Mock` type instead of widening to `DataSource`'s real
    // `transaction` overload signature.
    dataSource = { transaction: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfilesService,
        { provide: getRepositoryToken(Profile), useValue: findEmpty() },
        { provide: getRepositoryToken(SocialLink), useValue: findEmpty() },
        { provide: getRepositoryToken(WorkItem), useValue: findEmpty() },
        { provide: getRepositoryToken(Skill), useValue: findEmpty() },
        { provide: getRepositoryToken(BoardPost), useValue: boardPosts },
        {
          // Not exercised by any test in this file (these tests are about
          // BoardPost lifecycle, not responses), but the constructor now
          // requires it since Task 3 added it alongside `boardPosts`.
          provide: getRepositoryToken(BoardPostResponse),
          useValue: findEmpty(),
        },
        { provide: getRepositoryToken(Shaping), useValue: findEmpty() },
        { provide: getRepositoryToken(Activity), useValue: findEmpty() },
        { provide: getRepositoryToken(Group), useValue: findEmpty() },
        { provide: getRepositoryToken(GroupMembership), useValue: findEmpty() },
        {
          provide: getRepositoryToken(ProfileFeaturedCommunity),
          useValue: findEmpty(),
        },
        { provide: getRepositoryToken(Community), useValue: findEmpty() },
        { provide: getRepositoryToken(CommunityMember), useValue: findEmpty() },
        {
          provide: getRepositoryToken(ProfileNowHistory),
          useValue: findEmpty(),
        },
        { provide: DataSource, useValue: dataSource },
        {
          provide: VouchService,
          useValue: {
            getVouchCount: jest.fn().mockResolvedValue(0),
            getVouchCounts: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: ConnectionsService,
          useValue: { areConnected: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: BlockFilterService,
          useValue: {
            isBlockedEitherWay: jest.fn().mockResolvedValue(false),
            excludeBlocked: jest.fn((qb: unknown) => qb),
          },
        },
        {
          provide: HiddenFromService,
          useValue: {
            isHiddenFrom: jest.fn().mockResolvedValue(false),
            excludeHiddenFrom: jest.fn((qb: unknown) => qb),
          },
        },
        {
          provide: HandlesService,
          useValue: {
            rename: jest.fn(),
            // PRD-204: a missing slug asks the handle ledger whether it was
            // renamed away from. No reservation by default.
            previousProfileOwnerOf: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: StorageService,
          useValue: { deleteObjectByReference: jest.fn() },
        },
        {
          provide: ContentModerationService,
          useValue: {
            statesForAnyType: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          // The activity privacy gate: read-only here, with its own spec.
          provide: ActivityVisibilityService,
          useValue: {
            filterVisible: jest
              .fn()
              .mockImplementation((rows: unknown[]) => Promise.resolve(rows)),
          },
        },
        {
          // The coarse "recently active" band: read-only here, with its own
          // spec. Nothing recorded, so no band.
          provide: LastActiveService,
          useValue: {
            getSignal: jest
              .fn()
              .mockResolvedValue({ band: null, isHidden: false }),
            getSignals: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          // Its own spec covers the aggregate; every assertion in this file
          // is indifferent to `respondsWithin`, so a plain null default keeps
          // them all unaffected by its addition.
          provide: NowInsightsService,
          useValue: { getRespondsWithin: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();
    service = module.get(ProfilesService);

    dataSource.transaction.mockImplementation(
      async (cb: (m: typeof manager) => Promise<void>) => cb(manager),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const existingRow = (overrides: Partial<BoardPost> = {}): BoardPost => ({
    id: 'row-1',
    userId: USER_ID,
    kind: BoardKind.Offering,
    title: 'Help with web dev',
    slug: 'web-dev-help',
    position: 0,
    status: BoardPostStatus.Open,
    closedNote: null,
    closedAt: null,
    expiresAt: new Date('2026-06-01T00:00:00.000Z'),
    tags: [],
    renewedAt: null,
    renewCount: 0,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    ...overrides,
  });

  describe('replaceBoard', () => {
    it('gives a genuinely new item a fresh, kind-dependent expiresAt', async () => {
      manager.find.mockResolvedValue([]); // no existing rows for this user

      const lookingResult = await service.replaceBoard(USER_ID, [
        {
          kind: BoardKind.Looking,
          title: 'Need a roommate',
          slug: 'need-roommate',
        },
      ]);
      const lookingView = lookingResult[0];
      expect(lookingView).toBeDefined();
      expect(lookingView?.status).toBe('open');
      expect(lookingView?.closedAt).toBeNull();
      expect(lookingView?.expiresAt).toBe(
        new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString(),
      );
      expect(lookingView?.createdAt).toBe(new Date(NOW).toISOString());

      manager.find.mockResolvedValue([]);
      const offeringResult = await service.replaceBoard(USER_ID, [
        {
          kind: BoardKind.Offering,
          title: 'Free furniture',
          slug: 'free-furniture',
        },
      ]);
      const offeringView = offeringResult[0];
      expect(offeringView).toBeDefined();
      expect(offeringView?.expiresAt).toBe(
        new Date(NOW + 90 * 24 * 60 * 60 * 1000).toISOString(),
      );
    });

    it('preserves the original createdAt when re-saving an existing item with an edited title', async () => {
      const original = existingRow({
        createdAt: new Date('2026-05-01T08:00:00.000Z'),
      });
      manager.find.mockResolvedValue([original]);

      const result = await service.replaceBoard(USER_ID, [
        // Same slug, edited title — a normal re-save, e.g. because the
        // member also added an unrelated third item to their list.
        {
          kind: BoardKind.Offering,
          title: 'Help with web dev, now urgent!',
          slug: 'web-dev-help',
        },
      ]);

      const view = result[0];
      expect(view).toBeDefined();
      expect(view?.title).toBe('Help with web dev, now urgent!');
      // Must be the ORIGINAL createdAt, not the save-time timestamp — the FE
      // renders this as relative-age copy ("Asked 12 days ago"); resetting it
      // on an unrelated list edit would misdate the item for visitors.
      expect(view?.createdAt).toBe(original.createdAt.toISOString());
      expect(view?.createdAt).not.toBe(new Date(NOW).toISOString());
    });

    it('preserves the original expiresAt when re-saving an existing OPEN item', async () => {
      const original = existingRow({ status: BoardPostStatus.Open });
      manager.find.mockResolvedValue([original]);

      const result = await service.replaceBoard(USER_ID, [
        // Same slug, edited title — this is what a normal re-save of the
        // board list looks like (member tweaked wording, kept the item).
        {
          kind: BoardKind.Offering,
          title: 'Help with web dev (updated)',
          slug: 'web-dev-help',
        },
      ]);

      expect(result).toHaveLength(1);
      const view = result[0];
      expect(view).toBeDefined();
      expect(view?.title).toBe('Help with web dev (updated)');
      expect(view?.status).toBe('open');
      expect(view?.closedAt).toBeNull();
      expect(view?.closedNote).toBeNull();
      // Must be the ORIGINAL expiry, not a freshly computed one from `NOW`.
      expect(view?.expiresAt).toBe(original.expiresAt.toISOString());
      expect(view?.expiresAt).not.toBe(
        new Date(NOW + 90 * 24 * 60 * 60 * 1000).toISOString(),
      );
    });

    it('keeps a re-saved CLOSED item closed, with its original closedAt/closedNote intact', async () => {
      const closedAt = new Date('2026-07-15T09:30:00.000Z');
      const original = existingRow({
        status: BoardPostStatus.Closed,
        closedAt,
        closedNote: 'Found a roommate, thank you!',
      });
      manager.find.mockResolvedValue([original]);

      const result = await service.replaceBoard(USER_ID, [
        {
          kind: BoardKind.Offering,
          title: original.title,
          slug: original.slug,
        },
      ]);

      const view = result[0];
      expect(view).toBeDefined();
      expect(view?.status).toBe('closed');
      expect(view?.closedAt).toBe(closedAt.toISOString());
      expect(view?.closedNote).toBe('Found a roommate, thank you!');
      expect(view?.expiresAt).toBe(original.expiresAt.toISOString());
    });

    it('self-review scenario: one closed + one open item, adding a third on re-save preserves both', async () => {
      const closedAt = new Date('2026-07-15T09:30:00.000Z');
      const closedItem = existingRow({
        slug: 'closed-item',
        title: 'Closed thing',
        status: BoardPostStatus.Closed,
        closedAt,
        closedNote: 'All set',
        expiresAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      const openItem = existingRow({
        slug: 'open-item',
        title: 'Open thing',
        status: BoardPostStatus.Open,
        closedAt: null,
        closedNote: null,
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      manager.find.mockResolvedValue([closedItem, openItem]);

      const result = await service.replaceBoard(USER_ID, [
        {
          kind: BoardKind.Offering,
          title: closedItem.title,
          slug: closedItem.slug,
        },
        {
          kind: BoardKind.Offering,
          title: openItem.title,
          slug: openItem.slug,
        },
        {
          kind: BoardKind.Looking,
          title: 'Brand new ask',
          slug: 'brand-new-ask',
        },
      ]);

      const bySlug = new Map(result.map((view) => [view.slug, view]));

      const closedView = bySlug.get('closed-item')!;
      expect(closedView.status).toBe('closed');
      expect(closedView.closedAt).toBe(closedAt.toISOString());
      expect(closedView.closedNote).toBe('All set');
      expect(closedView.expiresAt).toBe(closedItem.expiresAt.toISOString());

      const openView = bySlug.get('open-item')!;
      expect(openView.status).toBe('open');
      expect(openView.closedAt).toBeNull();
      expect(openView.expiresAt).toBe(openItem.expiresAt.toISOString());

      const newView = bySlug.get('brand-new-ask')!;
      expect(newView.status).toBe('open');
      expect(newView.expiresAt).toBe(
        new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString(),
      );
    });

    // ---------------------------------------------------------------------
    // Row IDENTITY. `board_post_responses.post_id` references
    // `board_posts.id` ON DELETE CASCADE, so a replace that deletes and
    // recreates a surviving post silently destroys every offer to help and
    // every board-scoped hello it has received. These tests assert the row's
    // `id`, not just its field values: an implementation that recreates each
    // row with identical fields but a fresh UUID passes every field-equality
    // test above and still loses the responses.
    // ---------------------------------------------------------------------

    it('keeps a re-saved slug on its EXISTING row id, so its responses are not cascade-deleted', async () => {
      const original = existingRow({ id: 'row-with-responses' });
      manager.find.mockResolvedValue([original]);

      await service.replaceBoard(USER_ID, [
        {
          kind: BoardKind.Offering,
          title: 'Help with web dev, reworded',
          slug: 'web-dev-help',
        },
      ]);

      // The whole fix: same slug in, same row id out.
      expect(savedRows).toHaveLength(1);
      expect(savedRows[0]?.id).toBe('row-with-responses');
      expect(savedRows[0]?.title).toBe('Help with web dev, reworded');
      // A survivor is UPDATED, never recreated: nothing is deleted and
      // nothing is constructed for it.
      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.create).not.toHaveBeenCalled();
    });

    it('carries renewCount and renewedAt forward on a re-save, so the renew limit still bites', async () => {
      const renewedAt = new Date('2026-08-01T10:00:00.000Z');
      const original = existingRow({
        id: 'row-renewed',
        renewCount: 3,
        renewedAt,
        expiresAt: new Date('2026-11-01T00:00:00.000Z'),
      });
      manager.find.mockResolvedValue([original]);

      const result = await service.replaceBoard(USER_ID, [
        {
          kind: BoardKind.Offering,
          title: 'Help with web dev',
          slug: 'web-dev-help',
        },
      ]);

      // Resetting the counter to 0 while keeping the already pushed-out
      // expiry would defeat BOARD_RENEW_LIMIT: renew to the cap, save the
      // editor, renew to the cap again, forever.
      expect(savedRows[0]?.renewCount).toBe(3);
      expect(savedRows[0]?.renewedAt).toEqual(renewedAt);
      expect(savedRows[0]?.expiresAt).toEqual(original.expiresAt);
      expect(result[0]?.renewCount).toBe(3);
    });

    it('deletes ONLY the rows whose slug is absent from the payload', async () => {
      const kept = existingRow({ id: 'row-kept', slug: 'kept', title: 'Kept' });
      const dropped = existingRow({
        id: 'row-dropped',
        slug: 'dropped',
        title: 'Dropped',
      });
      manager.find.mockResolvedValue([kept, dropped]);

      await service.replaceBoard(USER_ID, [
        { kind: BoardKind.Offering, title: 'Kept', slug: 'kept' },
      ]);

      expect(manager.delete).toHaveBeenCalledTimes(1);
      const deleteCall = manager.delete.mock.calls[0] as [
        unknown,
        { userId: string; id: FindOperator<string> },
      ];
      expect(deleteCall[0]).toBe(BoardPost);
      // Scoped to the caller AND to the dropped row only — never a blanket
      // `{ userId }` delete of the whole board.
      expect(deleteCall[1].userId).toBe(USER_ID);
      expect(deleteCall[1].id.value).toEqual(['row-dropped']);

      expect(savedRows).toHaveLength(1);
      expect(savedRows[0]?.id).toBe('row-kept');
    });

    it('inserts a genuinely new slug with a fresh kind-dependent expiry, renewCount 0 and no explicit createdAt', async () => {
      manager.find.mockResolvedValue([]);

      await service.replaceBoard(USER_ID, [
        {
          kind: BoardKind.Looking,
          title: 'A collaborator for a queer zine',
          slug: 'zine-collab',
          tags: ['Illustration'],
        },
      ]);

      expect(manager.create).toHaveBeenCalledTimes(1);
      const createCalls = manager.create.mock.calls as [
        unknown,
        Partial<BoardPost>,
      ][];
      const created = createCalls[0]?.[1] ?? {};
      // No id is supplied, so the database mints one on insert.
      expect(Object.prototype.hasOwnProperty.call(created, 'id')).toBe(false);
      // Looking = 30 days from now, not the 90-day offering window.
      expect(created.expiresAt).toEqual(
        new Date(NOW + 30 * 24 * 60 * 60 * 1000),
      );
      expect(created.renewCount).toBe(0);
      expect(created.renewedAt).toBeNull();
      expect(created.status).toBe(BoardPostStatus.Open);
      expect(created.tags).toEqual(['Illustration']);
      // Left undefined on purpose so `@CreateDateColumn` populates it.
      expect(created.createdAt).toBeUndefined();
      // A genuinely new slug means nothing existed to delete.
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('still rejects an in-payload duplicate slug before opening a transaction', async () => {
      manager.find.mockResolvedValue([]);

      await expect(
        service.replaceBoard(USER_ID, [
          { kind: BoardKind.Offering, title: 'One', slug: 'same-slug' },
          { kind: BoardKind.Looking, title: 'Two', slug: 'same-slug' },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The unique (userId, slug) index is never given the chance to trip
      // mid-transaction: the payload is refused before any write happens.
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('reorders two existing posts by position without deleting or recreating either', async () => {
      const first = existingRow({
        id: 'row-first',
        slug: 'first',
        title: 'First',
        position: 0,
      });
      const second = existingRow({
        id: 'row-second',
        slug: 'second',
        title: 'Second',
        position: 1,
      });
      manager.find.mockResolvedValue([first, second]);

      const result = await service.replaceBoard(USER_ID, [
        { kind: BoardKind.Offering, title: 'Second', slug: 'second' },
        { kind: BoardKind.Offering, title: 'First', slug: 'first' },
      ]);

      // A swap touches `position` only. `slug` is the match key, so no row
      // ever hands its slug to another row and the unique (userId, slug)
      // index cannot be transiently violated mid-transaction.
      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.create).not.toHaveBeenCalled();

      const byId = new Map(savedRows.map((row) => [row.id, row]));
      expect(byId.get('row-second')?.position).toBe(0);
      expect(byId.get('row-first')?.position).toBe(1);
      expect(byId.get('row-second')?.slug).toBe('second');
      expect(byId.get('row-first')?.slug).toBe('first');
      expect(result.map((view) => view.slug)).toEqual(['second', 'first']);
    });
  });

  describe('closeBoardItem', () => {
    it('closes an open item and records the note/timestamp', async () => {
      const row = existingRow();
      boardPosts.findOne.mockResolvedValue(row);
      boardPosts.save.mockImplementation((r: BoardPost) => Promise.resolve(r));

      const result = await service.closeBoardItem(
        USER_ID,
        'web-dev-help',
        'Filled the role, thanks!',
      );

      expect(result.status).toBe('closed');
      expect(result.closedNote).toBe('Filled the role, thanks!');
      expect(result.closedAt).toBe(new Date(NOW).toISOString());
      expect(boardPosts.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: BoardPostStatus.Closed,
          closedNote: 'Filled the role, thanks!',
        }),
      );
    });

    it('404s when the slug does not belong to the caller', async () => {
      boardPosts.findOne.mockResolvedValue(null);
      await expect(
        service.closeBoardItem(USER_ID, 'nope', undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('renewBoardItem', () => {
    const openPost = (over: Partial<BoardPost> = {}) =>
      ({
        userId: USER_ID,
        kind: BoardKind.Looking,
        title: 'A collaborator for a queer zine',
        slug: 'zine-collab',
        status: BoardPostStatus.Open,
        closedNote: null,
        closedAt: null,
        expiresAt: new Date(NOW + 2 * 24 * 60 * 60 * 1000),
        createdAt: new Date(NOW - 28 * 24 * 60 * 60 * 1000),
        tags: ['Illustration'],
        renewedAt: null,
        renewCount: 0,
        ...over,
      }) as BoardPost;

    it('pushes a looking post 30 days out and records the renewal', async () => {
      const post = openPost();
      boardPosts.findOne.mockResolvedValue(post);
      boardPosts.save.mockImplementation((row: BoardPost) =>
        Promise.resolve(row),
      );

      const result = await service.renewBoardItem(USER_ID, 'zine-collab');

      expect(result.expiresAt).toBe(
        new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString(),
      );
      expect(post.renewCount).toBe(1);
      expect(post.renewedAt).toEqual(new Date(NOW));
    });

    it('pushes an offering post 90 days out', async () => {
      boardPosts.findOne.mockResolvedValue(
        openPost({ kind: BoardKind.Offering, slug: 'portfolio-reviews' }),
      );
      boardPosts.save.mockImplementation((row: BoardPost) =>
        Promise.resolve(row),
      );

      const result = await service.renewBoardItem(USER_ID, 'portfolio-reviews');

      expect(result.expiresAt).toBe(
        new Date(NOW + 90 * 24 * 60 * 60 * 1000).toISOString(),
      );
    });

    it('renews an already expired post from now, which is the repost action', async () => {
      boardPosts.findOne.mockResolvedValue(
        openPost({ expiresAt: new Date(NOW - 5 * 24 * 60 * 60 * 1000) }),
      );
      boardPosts.save.mockImplementation((row: BoardPost) =>
        Promise.resolve(row),
      );

      const result = await service.renewBoardItem(USER_ID, 'zine-collab');

      expect(result.expiresAt).toBe(
        new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString(),
      );
    });

    it('rejects an unknown slug', async () => {
      boardPosts.findOne.mockResolvedValue(null);
      await expect(
        service.renewBoardItem(USER_ID, 'nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses once the renew limit is reached', async () => {
      boardPosts.findOne.mockResolvedValue(openPost({ renewCount: 3 }));
      await expect(
        service.renewBoardItem(USER_ID, 'zine-collab'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(boardPosts.save).not.toHaveBeenCalled();
    });

    it('refuses a closed post, which is reopened through the editor instead', async () => {
      boardPosts.findOne.mockResolvedValue(
        openPost({ status: BoardPostStatus.Closed, closedAt: new Date(NOW) }),
      );
      await expect(
        service.renewBoardItem(USER_ID, 'zine-collab'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('scopes the lookup to the caller, so another member cannot renew it', async () => {
      boardPosts.findOne.mockResolvedValue(null);
      await expect(
        service.renewBoardItem('someone-else', 'zine-collab'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(boardPosts.findOne).toHaveBeenCalledWith({
        where: { userId: 'someone-else', slug: 'zine-collab' },
      });
    });
  });
});

import { DataSource, Repository } from 'typeorm';
import { AccountDeletionProcessorService } from './account-deletion-processor.service';
import { ContentOwnerErasureService } from './content-owner-erasure.service';
import {
  DeletionRequest,
  DeletionRequestStatus,
} from './entities/deletion-request.entity';
import { CommunityOwnerOrphanService } from '../communities/community-owner-orphan.service';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { MediaReferenceResolver } from '../media-references/media-reference.resolver';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';

/**
 * Step 4 of `eraseAccount`: what a member's erasure does to the objects they
 * uploaded.
 *
 * The bug these tests exist to keep closed: `event_photos.uploader_id` is `ON
 * DELETE SET NULL`, so a gathering photo's ROW survives the erasure with a null
 * uploader. Step 4 used to delete every object under `gathering-photos/<userId>/`
 * regardless, which left the album holding a tile that could never load again.
 * The same split hit every other `SET NULL` content type carrying media (a
 * listing gallery, a housing gallery, a community cover, a group photo).
 *
 * The chosen fix is the one the rest of the codebase already made: an object is
 * deleted only once nothing references it, exactly as `StorageMaintenanceService`,
 * `MyMediaService` and `AdminMediaService` delete. So the assertions here are
 * about WHICH objects go, and about the two directions the check can fail in.
 *
 * The DB half of the erasure (suppression row, moderation pseudonymization, the
 * `users` delete that cascades) is asserted only where step 4 depends on it;
 * the SQL semantics of the cascade belong to Postgres and to the e2e layer.
 */
describe('AccountDeletionProcessorService storage erasure', () => {
  const USER_ID = 'erased-member-id';
  const REQUEST_ID = 'deletion-request-id';

  // A gathering photo this member uploaded. Its `event_photos` row OUTLIVES the
  // erasure (SET NULL), so the object has to outlive it too.
  const GATHERING_PHOTO_KEY = `gathering-photos/${USER_ID}/album-tile.jpg`;
  // The member's own avatar. Its `profiles` row cascades away with the user, so
  // nothing references this once the transaction commits and it must go: this
  // is the leak the whole step exists to close.
  const AVATAR_KEY = `avatars/${USER_ID}/portrait.jpg`;
  // Presigned, never persisted to any column. Referenced by nothing from the
  // moment it was written, and still has to go.
  const ABANDONED_KEY = `work/${USER_ID}/never-saved.jpg`;

  let deletionRequests: {
    find: jest.Mock;
    update: jest.Mock;
  };
  let storage: {
    listUserObjects: jest.Mock;
    deleteObjectByKey: jest.Mock;
    deleteUserObjects: jest.Mock;
  };
  let manager: {
    createQueryBuilder: jest.Mock;
    query: jest.Mock;
    delete: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock; getRepository: jest.Mock };
  let communityOwnerOrphan: { handleOwnerErasure: jest.Mock };
  let contentOwnerErasure: { eraseFor: jest.Mock };
  let notifications: { create: jest.Mock; createForRecipients: jest.Mock };
  let service: AccountDeletionProcessorService;

  /** Entities whose repository throws, to force a degraded resolution. */
  let failingEntities: Set<unknown>;
  /** Rows the stubbed `event_photos` repository reports as still referencing. */
  let eventPhotoRows: Array<{ id: string; storageKey: string }>;

  const dueRequest = (): DeletionRequest =>
    ({
      id: REQUEST_ID,
      userId: USER_ID,
      status: DeletionRequestStatus.Grace,
      scheduledFor: new Date(Date.now() - 1000),
      finalWarningSentAt: null,
    }) as DeletionRequest;

  const deletedKeys = (): string[] =>
    (storage.deleteObjectByKey.mock.calls as Array<[string]>).map(
      ([key]) => key,
    );

  /** Jest's global call counter for a mock's first invocation, so two mocks can
   *  be ordered against each other. `-1` when the mock was never called, which
   *  fails the comparison loudly rather than passing on `undefined`. */
  const firstCallOrder = (mock: jest.Mock): number =>
    mock.mock.invocationCallOrder[0] ?? -1;

  beforeEach(() => {
    failingEntities = new Set();
    eventPhotoRows = [{ id: 'photo-1', storageKey: GATHERING_PHOTO_KEY }];

    // One chainable stub covering both query builders the transaction uses: the
    // `addSelect('user.email')` read and the suppression `insert().orIgnore()`.
    const queryBuilder: Record<string, unknown> = {};
    Object.assign(queryBuilder, {
      addSelect: jest.fn().mockReturnValue(queryBuilder),
      where: jest.fn().mockReturnValue(queryBuilder),
      getOne: jest
        .fn()
        .mockResolvedValue({ id: USER_ID, email: 'member@example.test' }),
      insert: jest.fn().mockReturnValue(queryBuilder),
      into: jest.fn().mockReturnValue(queryBuilder),
      values: jest.fn().mockReturnValue(queryBuilder),
      orIgnore: jest.fn().mockReturnValue(queryBuilder),
      execute: jest.fn().mockResolvedValue(undefined),
    });

    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      query: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    // The `MediaReferenceResolver` step 4 uses is constructed below from this
    // same DataSource stub, so the stub is also what decides which keys come
    // back referenced. It is the real resolver rather than a mock deliberately:
    // the thing under test is whether a surviving row keeps its object, and a
    // stubbed "yes it is referenced" would assert nothing about that.
    // Every source either `find()`s a plain column or query-builds a jsonb one;
    // only the `event_photos` source is given a matching row.
    dataSource = {
      transaction: jest.fn(
        async (run: (entityManager: unknown) => Promise<unknown>) =>
          run(manager),
      ),
      getRepository: jest.fn((entity: unknown) => {
        if (failingEntities.has(entity)) {
          throw new Error('reference source unavailable');
        }
        const arrayQueryBuilder: Record<string, unknown> = {};
        Object.assign(arrayQueryBuilder, {
          where: jest.fn().mockReturnValue(arrayQueryBuilder),
          andWhere: jest.fn().mockReturnValue(arrayQueryBuilder),
          getMany: jest.fn().mockResolvedValue([]),
        });
        return {
          metadata: { tableName: 'stub_table' },
          find: jest
            .fn()
            .mockResolvedValue(entity === EventPhoto ? eventPhotoRows : []),
          createQueryBuilder: jest.fn().mockReturnValue(arrayQueryBuilder),
        };
      }),
    };

    storage = {
      listUserObjects: jest.fn().mockResolvedValue([
        { key: GATHERING_PHOTO_KEY, size: 1, lastModified: null },
        { key: AVATAR_KEY, size: 1, lastModified: null },
        { key: ABANDONED_KEY, size: 1, lastModified: null },
      ]),
      deleteObjectByKey: jest.fn().mockResolvedValue(undefined),
      deleteUserObjects: jest.fn().mockResolvedValue(0),
    };

    deletionRequests = {
      // First call is the erasure sweep, second is the final-warning sweep.
      find: jest
        .fn()
        .mockResolvedValueOnce([dueRequest()])
        .mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    communityOwnerOrphan = { handleOwnerErasure: jest.fn() };
    contentOwnerErasure = { eraseFor: jest.fn() };
    notifications = { create: jest.fn(), createForRecipients: jest.fn() };

    service = new AccountDeletionProcessorService(
      deletionRequests as unknown as Repository<DeletionRequest>,
      dataSource as unknown as DataSource,
      storage as unknown as StorageService,
      communityOwnerOrphan as unknown as CommunityOwnerOrphanService,
      contentOwnerErasure as unknown as ContentOwnerErasureService,
      notifications as unknown as NotificationsService,
      new MediaReferenceResolver(dataSource as unknown as DataSource),
    );
  });

  describe('what survives the erasure', () => {
    it('keeps the gathering photo whose album row outlives the member, and deletes the objects nothing points at', async () => {
      // THE central assertion. `event_photos.uploader_id` is SET NULL, so the
      // tile stays in the album with no uploader; deleting the object under it
      // would leave a permanently broken tile in someone else's record of their
      // own event. The avatar and the abandoned upload are referenced by
      // nothing once the user row is gone, so they go.
      await service.processDueDeletions();

      expect(deletedKeys()).toEqual([AVATAR_KEY, ABANDONED_KEY]);
      expect(deletedKeys()).not.toContain(GATHERING_PHOTO_KEY);
    });

    it('never falls back to the blanket per-prefix sweep', async () => {
      // `StorageService.deleteUserObjects` removes everything under
      // `<kind>/<userId>/` with no reference check at all. Calling it is the
      // bug: it is what deleted the gathering photo out from under its row.
      await service.processDueDeletions();

      expect(storage.deleteUserObjects).not.toHaveBeenCalled();
    });

    it('deletes the gathering photo once its album row is gone too', async () => {
      // The mirror case, so the retention is not simply "gathering photos are
      // immortal": if the gathering itself was deleted (the `event_id` FK is
      // CASCADE), nothing references the object and it is erased like any other.
      eventPhotoRows = [];

      await service.processDueDeletions();

      expect(deletedKeys()).toContain(GATHERING_PHOTO_KEY);
    });
  });

  describe('when the reference check cannot be trusted', () => {
    it('deletes nothing in a batch whose reference resolution degraded', async () => {
      // `degraded` means a source query threw and its answers are missing, so
      // "no references" is not authoritative. Every other delete path in the
      // codebase refuses on degraded (`StorageMaintenanceService`,
      // `MyMediaService`, `AdminMediaService`) and so does this one: keeping an
      // object too long is recoverable, deleting a live one is permanent.
      failingEntities.add(Profile);

      await service.processDueDeletions();

      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
    });

    it('still stamps the request erased when the storage sweep fails outright', async () => {
      // The DB erasure has already committed by then, and it is the
      // legally-binding half. A storage failure must never park the row back in
      // `processing` and re-run the erasure.
      storage.listUserObjects.mockRejectedValue(
        new Error('bucket unreachable'),
      );

      await service.processDueDeletions();

      expect(deletionRequests.update).toHaveBeenCalledWith(
        { id: REQUEST_ID },
        expect.objectContaining({ status: DeletionRequestStatus.Erased }),
      );
    });

    it('carries on erasing after one object fails to delete', async () => {
      // One unhappy key must not leave the rest of a member's uploads behind.
      storage.deleteObjectByKey.mockRejectedValueOnce(new Error('no such key'));

      await service.processDueDeletions();

      expect(deletedKeys()).toEqual([AVATAR_KEY, ABANDONED_KEY]);
    });
  });

  describe('ordering', () => {
    it('resolves owned communities and dependent content before deleting the user row', async () => {
      // Both services find their work by `owner_id`/`host_id = :userId`, and the
      // SET NULL FKs blank those columns the moment the user row goes.
      await service.processDueDeletions();

      expect(communityOwnerOrphan.handleOwnerErasure).toHaveBeenCalledWith(
        USER_ID,
      );
      expect(contentOwnerErasure.eraseFor).toHaveBeenCalledWith(USER_ID);
      const deleteOrder = firstCallOrder(manager.delete);
      expect(
        firstCallOrder(communityOwnerOrphan.handleOwnerErasure),
      ).toBeLessThan(deleteOrder);
      expect(firstCallOrder(contentOwnerErasure.eraseFor)).toBeLessThan(
        deleteOrder,
      );
      expect(manager.delete).toHaveBeenCalledWith(User, { id: USER_ID });
    });

    it('checks references only after the user row deletion has committed', async () => {
      // Asked inside the transaction, the resolver would still see the rows the
      // cascade is about to remove and would keep their objects forever. The
      // check therefore runs against committed post-cascade state, which is also
      // why the fix adds no DB write and nothing here can half-apply.
      await service.processDueDeletions();

      expect(firstCallOrder(manager.delete)).toBeLessThan(
        firstCallOrder(storage.listUserObjects),
      );
    });
  });
});

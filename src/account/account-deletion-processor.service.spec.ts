import { DataSource, Repository } from 'typeorm';
import { AccountDeletionProcessorService } from './account-deletion-processor.service';
import { ContentOwnerErasureService } from './content-owner-erasure.service';
import {
  DeletionRequest,
  DeletionRequestStatus,
} from './entities/deletion-request.entity';
import { CommunityOwnerOrphanService } from '../communities/community-owner-orphan.service';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { forumThreadVisibleSql } from '../forum/forum-threads.service';
import { MediaReferenceResolver } from '../media-references/media-reference.resolver';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { SubprofileMembershipService } from '../subprofiles/subprofile-membership.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';
import { releaseHandleWithin } from '../handles/handles.service';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { PersonaStorageKey } from '../storage/entities/persona-storage-key.entity';

// Step 2d releases erased personas' handles through the registry's own
// release. Partial mock: every other export stays real.
jest.mock('../handles/handles.service', () => ({
  ...jest.requireActual<Record<string, unknown>>('../handles/handles.service'),
  releaseHandleWithin: jest.fn(),
}));

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
    find: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock; getRepository: jest.Mock };
  let communityOwnerOrphan: { handleOwnerErasure: jest.Mock };
  let contentOwnerErasure: { eraseFor: jest.Mock };
  let notifications: { create: jest.Mock; createForRecipients: jest.Mock };
  let subprofileMembership: { handOverCreatedPersonasFor: jest.Mock };
  let service: AccountDeletionProcessorService;

  /** Entities whose repository throws, to force a degraded resolution. */
  let failingEntities: Set<unknown>;
  /** Rows the stubbed `event_photos` repository reports as still referencing. */
  let eventPhotoRows: Array<{ id: string; storageKey: string }>;
  /** T17: the persona-scoped keys the registry says this member uploaded. */
  let personaRegistryRows: Array<{ storageKey: string }>;
  /** T17: persona rows the stubbed `subprofiles` repository reports as still
   *  showing an image (a persona handed over to a co-owner). */
  let personaRows: Array<Record<string, unknown>>;
  /** T17: the registry repository's delete, per erased persona key. */
  let personaRegistryDelete: jest.Mock;

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
    personaRegistryRows = [];
    personaRows = [];
    personaRegistryDelete = jest.fn().mockResolvedValue({ affected: 1 });

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
      // `[]` is what `manager.query` returns for a statement that matches no
      // rows, and step 2b reads its results as arrays.
      query: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      // Step 2d's persona and handle reads. None by default.
      find: jest.fn().mockResolvedValue([]),
    };
    (releaseHandleWithin as jest.Mock).mockReset().mockResolvedValue(undefined);

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
            .mockResolvedValue(
              entity === EventPhoto
                ? eventPhotoRows
                : entity === PersonaStorageKey
                  ? personaRegistryRows
                  : entity === Subprofile
                    ? personaRows
                    : [],
            ),
          delete: personaRegistryDelete,
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
    subprofileMembership = {
      handOverCreatedPersonasFor: jest.fn().mockResolvedValue(undefined),
    };

    service = new AccountDeletionProcessorService(
      deletionRequests as unknown as Repository<DeletionRequest>,
      dataSource as unknown as DataSource,
      storage as unknown as StorageService,
      communityOwnerOrphan as unknown as CommunityOwnerOrphanService,
      contentOwnerErasure as unknown as ContentOwnerErasureService,
      notifications as unknown as NotificationsService,
      new MediaReferenceResolver(dataSource as unknown as DataSource),
      subprofileMembership as unknown as SubprofileMembershipService,
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

  // T17: an unlinked persona's images live under `persona/<uuid>/<uuid><ext>`,
  // which the per-prefix listing cannot find; the registry names their
  // uploader until the user row goes.
  describe('persona-scoped images the member uploaded', () => {
    const SEGMENT = '0b6f2a4c-1d2e-4f30-9a8b-7c6d5e4f3a2b';
    const UNUSED_PERSONA_KEY = `persona/${SEGMENT}/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d.jpg`;
    const SHOWN_PERSONA_KEY = `persona/${SEGMENT}/6b5c4d3e-2f1a-4b0c-9d8e-7f6a5b4c3d2e.png`;

    beforeEach(() => {
      personaRegistryRows = [
        { storageKey: UNUSED_PERSONA_KEY },
        { storageKey: SHOWN_PERSONA_KEY },
      ];
    });

    it('reads them before the transaction, while the uploader column still names the member', async () => {
      await service.processDueDeletions();

      const registryRead = (dataSource.getRepository.mock.calls as unknown[][])
        .map(([entity], index) => ({ entity, index }))
        .find(({ entity }) => entity === PersonaStorageKey);
      expect(registryRead).toBeDefined();
      const readOrder =
        dataSource.getRepository.mock.invocationCallOrder[
          registryRead?.index ?? -1
        ] ?? -1;
      expect(readOrder).toBeLessThan(firstCallOrder(dataSource.transaction));
    });

    it('erases the ones nothing shows, with their registry rows, and keeps one a handed-over persona still shows', async () => {
      personaRows = [
        {
          id: 'persona-1',
          avatarUrl: SHOWN_PERSONA_KEY,
          displayName: 'Nightform',
          handle: 'nightform',
        },
      ];

      await service.processDueDeletions();

      expect(deletedKeys()).toContain(UNUSED_PERSONA_KEY);
      expect(deletedKeys()).not.toContain(SHOWN_PERSONA_KEY);
      expect(personaRegistryDelete).toHaveBeenCalledWith({
        storageKey: UNUSED_PERSONA_KEY,
      });
      expect(personaRegistryDelete).not.toHaveBeenCalledWith({
        storageKey: SHOWN_PERSONA_KEY,
      });
    });

    it('deletes none of them when the reference check degraded', async () => {
      failingEntities.add(Profile);

      await service.processDueDeletions();

      expect(deletedKeys()).not.toContain(UNUSED_PERSONA_KEY);
      expect(personaRegistryDelete).not.toHaveBeenCalled();
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

    it('hands over the shared personas the member created before deleting the user row', async () => {
      // `subprofiles.user_id` is ON DELETE CASCADE, so once the user row goes
      // every persona they created goes with it, co-owners and all. The
      // handover has to run first, and after the content steps it follows.
      await service.processDueDeletions();

      expect(
        subprofileMembership.handOverCreatedPersonasFor,
      ).toHaveBeenCalledWith(USER_ID);
      const handOverOrder = firstCallOrder(
        subprofileMembership.handOverCreatedPersonasFor,
      );
      expect(firstCallOrder(contentOwnerErasure.eraseFor)).toBeLessThan(
        handOverOrder,
      );
      expect(handOverOrder).toBeLessThan(firstCallOrder(manager.delete));
      // Outside the erasure transaction: the handover commits per persona and
      // emits after each commit, so it must have finished before the
      // transaction opens.
      expect(handOverOrder).toBeLessThan(
        firstCallOrder(dataSource.transaction),
      );
    });

    // ENG-449: a sole-owned persona cascades away with the user row, so its
    // registry handle is released (no forwarding) inside the erasure
    // transaction first, and the name stays reserved for the cooldown.
    it("releases the erased member's persona handles without forwarding before deleting the user row", async () => {
      manager.find.mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === Subprofile
            ? [{ id: 'persona-1' }]
            : entity === Handle
              ? [{ name: 'after-dark', subprofileId: 'persona-1' }]
              : [],
        ),
      );

      await service.processDueDeletions();

      // N5: the persona row is locked FIRST, matching the lock order every
      // other persona writer uses (persona row, then handles): see
      // `subprofile-membership.service.ts`'s `pessimistic_write` reads.
      expect(manager.find).toHaveBeenCalledWith(Subprofile, {
        where: { userId: USER_ID },
        select: { id: true },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.find).toHaveBeenCalledWith(
        Handle,
        expect.objectContaining({
          where: expect.objectContaining({
            ownerKind: HandleOwnerKind.Subprofile,
          }) as unknown,
        }),
      );
      const findCalls = manager.find.mock.calls as unknown[][];
      const subprofileFindOrder =
        manager.find.mock.invocationCallOrder[
          findCalls.findIndex((call) => call[0] === Subprofile)
        ] ?? -1;
      const handleFindOrder =
        manager.find.mock.invocationCallOrder[
          findCalls.findIndex((call) => call[0] === Handle)
        ] ?? -1;
      expect(subprofileFindOrder).toBeLessThan(handleFindOrder);
      expect(releaseHandleWithin).toHaveBeenCalledWith(
        manager,
        'after-dark',
        { kind: 'subprofile', subprofileId: 'persona-1' },
        { isForwarding: false },
      );
      expect(firstCallOrder(releaseHandleWithin as jest.Mock)).toBeLessThan(
        firstCallOrder(manager.delete),
      );
    });

    it('releases nothing when the member created no persona', async () => {
      await service.processDueDeletions();

      expect(releaseHandleWithin).not.toHaveBeenCalled();
      expect(manager.find).not.toHaveBeenCalledWith(Handle, expect.anything());
      expect(manager.delete).toHaveBeenCalled();
    });

    it('stops before deleting anything when the persona handover fails', async () => {
      // A failed handover must never fall through to the cascade, which would
      // delete the shared personas it was meant to save. The request stays
      // parked in `processing` for a human to retry.
      subprofileMembership.handOverCreatedPersonasFor.mockRejectedValue(
        new Error('handover failed'),
      );

      await service.processDueDeletions();

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
      expect(storage.listUserObjects).not.toHaveBeenCalled();
      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
      expect(deletionRequests.update).not.toHaveBeenCalledWith(
        { id: REQUEST_ID },
        expect.objectContaining({ status: DeletionRequestStatus.Erased }),
      );
    });

    // M2: step 0b's forum thread deletion runs isolated and only logs a
    // failure, so the processor sweeps inside the transaction, after the user
    // delete has blanked `author_id`, for anything that would otherwise
    // publish later under the placeholder byline.
    it("sweeps the erased member's unpublished and withdrawn forum threads after the user delete, scoped to authorless rows", async () => {
      const WITHDRAWN_THREAD_ID = 'withdrawn-thread-id';
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('SELECT "t"."id" FROM "forum_thread"')
            ? [{ id: WITHDRAWN_THREAD_ID }]
            : [],
        ),
      );

      await service.processDueDeletions();

      const queryCalls = manager.query.mock.calls as Array<[string, unknown[]]>;
      const captureIndex = queryCalls.findIndex(([sql]) =>
        sql.includes('SELECT "t"."id" FROM "forum_thread"'),
      );
      const sweepIndex = queryCalls.findIndex(([sql]) =>
        sql.includes('DELETE FROM "forum_thread"'),
      );
      expect(captureIndex).toBeGreaterThanOrEqual(0);
      expect(sweepIndex).toBeGreaterThanOrEqual(0);

      // The withdrawn ids are read while `author_id` still names the member.
      const [captureSql, captureParams] = queryCalls[captureIndex]!;
      expect(captureSql).toContain('"t"."author_id" = $1');
      expect(captureSql).toContain('"t"."deleted_at" IS NOT NULL');
      expect(captureParams).toEqual([USER_ID]);
      expect(manager.query.mock.invocationCallOrder[captureIndex]).toBeLessThan(
        firstCallOrder(manager.delete),
      );

      // The sweep runs after the user delete and can only reach authorless
      // threads: unpublished ones, or this member's own withdrawn ones.
      const [sweepSql, sweepParams] = queryCalls[sweepIndex]!;
      expect(firstCallOrder(manager.delete)).toBeLessThan(
        manager.query.mock.invocationCallOrder[sweepIndex]!,
      );
      expect(sweepSql).toContain('"t"."author_id" IS NULL');
      expect(sweepSql).toContain(`NOT (${forumThreadVisibleSql('"t"')})`);
      expect(sweepSql).toMatch(
        /"t"\."deleted_at" IS NOT NULL\s*AND "t"\."id" = ANY\(\$1::uuid\[\]\)/,
      );
      expect(sweepParams).toEqual([[WITHDRAWN_THREAD_ID]]);
    });

    // Funding & Grants: step 0b's removal of a surviving fundraiser's donate
    // link runs isolated, so the transaction repeats it while `author_id`
    // still names the member, before the user delete blanks it.
    it("deletes the member's fundraiser funding rows inside the transaction, before the user delete", async () => {
      await service.processDueDeletions();

      const queryCalls = manager.query.mock.calls as Array<[string, unknown[]]>;
      const fundingIndex = queryCalls.findIndex(([sql]) =>
        sql.includes('DELETE FROM "forum_thread_funding"'),
      );
      expect(fundingIndex).toBeGreaterThanOrEqual(0);

      const [fundingSql, fundingParams] = queryCalls[fundingIndex]!;
      expect(fundingSql).toContain('USING "forum_thread" AS "t"');
      expect(fundingSql).toContain('"funding"."thread_id" = "t"."id"');
      expect(fundingSql).toContain('"t"."author_id" = $1');
      expect(fundingSql).toContain(`"t"."kind" = 'ask'`);
      expect(fundingParams).toEqual([USER_ID]);
      expect(manager.query.mock.invocationCallOrder[fundingIndex]).toBeLessThan(
        firstCallOrder(manager.delete),
      );
    });

    it('leaves the request parked when the fundraiser funding deletion fails', async () => {
      manager.query.mockImplementation((sql: string) =>
        sql.includes('DELETE FROM "forum_thread_funding"')
          ? Promise.reject(new Error('funding delete failed'))
          : Promise.resolve([]),
      );

      await service.processDueDeletions();

      expect(manager.delete).not.toHaveBeenCalledWith(User, { id: USER_ID });
      expect(deletionRequests.update).not.toHaveBeenCalledWith(
        { id: REQUEST_ID },
        expect.objectContaining({ status: DeletionRequestStatus.Erased }),
      );
    });

    it('leaves the request parked when the forum thread sweep fails', async () => {
      manager.query.mockImplementation((sql: string) =>
        sql.includes('DELETE FROM "forum_thread"')
          ? Promise.reject(new Error('sweep failed'))
          : Promise.resolve([]),
      );

      await service.processDueDeletions();

      // The erasure reached the sweep: the user delete ran, then the sweep
      // failed after it and rolled the transaction back.
      expect(manager.delete).toHaveBeenCalledWith(User, { id: USER_ID });
      const sweepCallIndex = (
        manager.query.mock.calls as Array<[string, unknown[]]>
      ).findIndex(([sql]) => sql.includes('DELETE FROM "forum_thread"'));
      expect(sweepCallIndex).toBeGreaterThanOrEqual(0);
      expect(firstCallOrder(manager.delete)).toBeLessThan(
        manager.query.mock.invocationCallOrder[sweepCallIndex]!,
      );

      expect(deletionRequests.update).not.toHaveBeenCalledWith(
        { id: REQUEST_ID },
        expect.objectContaining({ status: DeletionRequestStatus.Erased }),
      );
      expect(storage.listUserObjects).not.toHaveBeenCalled();
    });

    // ENG-499: the member's DSAR rows survive the user delete as a statutory
    // record, so their own free text is wiped first, keyed on the member id.
    it("wipes the member's DSAR free text before deleting the user row", async () => {
      await service.processDueDeletions();

      const queryCalls = manager.query.mock.calls as Array<[string, unknown[]]>;
      const scrubIndex = queryCalls.findIndex(([sql]) =>
        sql.includes('UPDATE "dsar_request"'),
      );
      expect(scrubIndex).toBeGreaterThanOrEqual(0);

      const [scrubSql, scrubParams] = queryCalls[scrubIndex]!;
      expect(scrubSql).toContain(`"details" = ''`);
      expect(scrubSql).toContain('"context" = NULL');
      expect(scrubSql).toContain('WHERE "user_id" = $1');
      expect(scrubSql).not.toContain('DELETE');
      expect(scrubParams).toEqual([USER_ID]);
      expect(manager.query.mock.invocationCallOrder[scrubIndex]).toBeLessThan(
        firstCallOrder(manager.delete),
      );
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

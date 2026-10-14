import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { forumThreadVisibleSql } from '../forum/forum-threads.service';
import { BlockFilterService } from '../social/block-filter.service';
import {
  creditPersonaCreatorIdSql,
  ownerHoldsGrantSql,
  personaCreatorBlockExemptSql,
} from '../studio/studio-playlist-visibility';
import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { episodeReleasedSql } from '../studio/studio-episode-rule';
import { withdrawnReleaseSql } from '../studio/studio-visibility';
import { SavedAvailabilityService } from './saved-availability.service';

/**
 * One chainable query-builder stub per resolved kind. `getRawMany` resolves to
 * whatever `rowsByAlias` holds for the alias the service asked for, which is
 * how a test says "this slug is still there and that one is not".
 */
const makeManager = (rowsByAlias: Record<string, string[]> = {}) => {
  const createQueryBuilder = jest.fn((_entity: unknown, alias: string) => {
    const queryBuilder: Record<string, jest.Mock> = {};
    for (const method of ['where', 'andWhere', 'select', 'innerJoin']) {
      queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
    }
    queryBuilder.getRawMany = jest
      .fn()
      .mockResolvedValue(
        (rowsByAlias[alias] ?? []).map((key) => ({ subject_key: key })),
      );
    return queryBuilder;
  });
  return {
    createQueryBuilder,
    connection: {
      // Every probed column is reported present: the `deleted_at` probe exists
      // for a sibling module mid-flight, not as behaviour this file owns.
      getMetadata: jest.fn(() => ({
        columns: [{ propertyName: 'deletedAt' }],
      })),
    },
  };
};

const ref = (
  subjectType: SavedKind,
  subjectId: string,
): Pick<SavedItem, 'subjectType' | 'subjectId'> => ({ subjectType, subjectId });

describe('SavedAvailabilityService', () => {
  let manager: ReturnType<typeof makeManager>;
  let service: SavedAvailabilityService;
  let excludeBlocked: jest.Mock;

  const build = async (rowsByAlias: Record<string, string[]> = {}) => {
    manager = makeManager(rowsByAlias);
    excludeBlocked = jest.fn((queryBuilder: unknown) => queryBuilder);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavedAvailabilityService,
        {
          provide: getRepositoryToken(SavedItem),
          useValue: { manager },
        },
        {
          provide: BlockFilterService,
          useValue: {
            excludeBlocked,
          },
        },
      ],
    }).compile();
    service = module.get(SavedAvailabilityService);
  };

  it('asks nothing at all for an empty page', async () => {
    await build();
    const available = await service.availableRefs([], 'viewer-1');
    expect(available.size).toBe(0);
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('resolves a whole page of ONE kind in a single query, never one per item', async () => {
    await build({ thread: ['first', 'second', 'third'] });

    const available = await service.availableRefs(
      [
        ref(SavedKind.Post, 'first'),
        ref(SavedKind.Post, 'second'),
        ref(SavedKind.Post, 'third'),
      ],
      'viewer-1',
    );

    // The N+1 this service exists to prevent. Three saved threads, one query.
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(available).toEqual(
      new Set(['post:first', 'post:second', 'post:third']),
    );
  });

  it('costs one query PER KIND on the page, not one per item', async () => {
    await build({ thread: ['a-thread'], community: ['a-group'] });

    await service.availableRefs(
      [
        ref(SavedKind.Post, 'a-thread'),
        ref(SavedKind.Post, 'another-thread'),
        ref(SavedKind.Group, 'a-group'),
        ref(SavedKind.Group, 'another-group'),
      ],
      'viewer-1',
    );

    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(2);
  });

  it('reports a subject the query did not return as NOT available', async () => {
    // The thread was deleted, or its community went private: it is simply
    // absent from the result rather than flagged.
    await build({ thread: ['still-here'] });

    const available = await service.availableRefs(
      [ref(SavedKind.Post, 'still-here'), ref(SavedKind.Post, 'long-gone')],
      'viewer-1',
    );

    expect(available.has('post:still-here')).toBe(true);
    expect(available.has('post:long-gone')).toBe(false);
  });

  describe('the bookmarked-thread gate', () => {
    // Every predicate the thread query folded on, in the order it folded them.
    const foldedPredicates = (): string[] => {
      const result = manager.createQueryBuilder.mock.results[0] as
        { value: Record<string, jest.Mock> } | undefined;
      const andWhere = result?.value.andWhere;
      if (!andWhere) return [];
      return andWhere.mock.calls.map((call: unknown[]) => String(call[0]));
    };

    it("carries the forum's own scheduled/under-review gate, verbatim", async () => {
      // The regression this closes: this service re-implements `loadOr404`
      // predicate for predicate, fell exactly one predicate behind when the
      // scheduled/under-review gate landed, and so kept rendering the TITLE of
      // a bookmarked thread that was scheduled for next week or still waiting
      // on a moderator.
      await build({ thread: ['a-thread'] });

      await service.availableRefs(
        [ref(SavedKind.Post, 'a-thread')],
        'viewer-1',
      );

      // Asserted against the forum's own exported predicate rather than a
      // string typed here, which is the entire point: a third spelling is what
      // fell behind in the first place.
      expect(
        foldedPredicates().some((sql) =>
          sql.includes(forumThreadVisibleSql('"thread"')),
        ),
      ).toBe(true);
    });

    it("lets the thread's own author past it, as `loadOr404` does", async () => {
      await build({ thread: ['a-thread'] });

      await service.availableRefs(
        [ref(SavedKind.Post, 'a-thread')],
        'viewer-1',
      );

      const gate = foldedPredicates().find((sql) =>
        sql.includes(forumThreadVisibleSql('"thread"')),
      );
      // One arm, in the SAME predicate as the gate: an author who bookmarked a
      // thread they themself scheduled can still open it, so reporting it as
      // unavailable would be the wrong answer.
      expect(gate).toContain('"thread"."author_id" = :savedViewerId');
    });

    it('still excludes withdrawn threads alongside it', async () => {
      await build({ thread: ['a-thread'] });

      await service.availableRefs(
        [ref(SavedKind.Post, 'a-thread')],
        'viewer-1',
      );

      expect(
        foldedPredicates().some((sql) => sql.includes('"deleted_at" IS NULL')),
      ).toBe(true);
    });

    // PRD-407: `loadOr404` serves a cross-posted thread to a non-member of
    // its community, so a bookmark of one must stay available too.
    it('saved list keeps a cross-posted thread', async () => {
      await build({ thread: ['a-thread'] });

      await service.availableRefs(
        [ref(SavedKind.Post, 'a-thread')],
        'viewer-1',
      );

      const communityGate = foldedPredicates().find((sql) =>
        sql.includes('"saved_com"'),
      );
      expect(communityGate).toMatch(
        /"thread"\."community_id" IS NULL\s*OR "thread"\."cross_posted" = true\s*OR NOT EXISTS/,
      );
    });
  });

  it('deduplicates a subject id repeated on the page', async () => {
    await build({ listing: ['drama-bar'] });

    const available = await service.availableRefs(
      [
        ref(SavedKind.Listing, 'drama-bar'),
        ref(SavedKind.Listing, 'drama-bar'),
      ],
      'viewer-1',
    );

    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(available).toEqual(new Set(['listing:drama-bar']));
  });

  describe('a saved housing listing', () => {
    it('is filtered on its owner column for blocks in either direction, in the same query', async () => {
      await build({ housing: ['a-room'] });

      const available = await service.availableRefs(
        [ref(SavedKind.Housing, 'a-room'), ref(SavedKind.Housing, 'b-room')],
        'viewer-1',
      );

      expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(excludeBlocked).toHaveBeenCalledTimes(1);
      expect(excludeBlocked).toHaveBeenCalledWith(
        expect.anything(),
        'viewer-1',
        '"housing"."owner_id"',
      );
      expect(available).toEqual(new Set(['housing:a-room']));
    });
  });

  describe('an anonymous share-link recipient', () => {
    it('can still open the business directory', async () => {
      await build({ listing: ['drama-bar'] });

      const available = await service.availableRefs(
        [ref(SavedKind.Listing, 'drama-bar')],
        null,
      );

      expect(available).toEqual(new Set(['listing:drama-bar']));
    });

    it('gets "unavailable" for every member-only kind, without querying', async () => {
      await build({ thread: ['a-thread'], community: ['a-group'] });

      const available = await service.availableRefs(
        [
          ref(SavedKind.Post, 'a-thread'),
          ref(SavedKind.Group, 'a-group'),
          ref(SavedKind.Housing, 'a-room'),
          ref(SavedKind.Article, 'a-piece'),
        ],
        null,
      );

      // Every one of those modules puts `ActiveMemberGuard` on its controller,
      // so the card would land the recipient on a sign-in wall. Refused before
      // any SQL runs.
      expect(available.size).toBe(0);
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  it('refuses a kind whose feature is not launched, without querying', async () => {
    await build({ job: ['senior-eng'], title: ['a-film-uuid'] });

    const available = await service.availableRefs(
      [
        ref(SavedKind.Job, 'senior-eng'),
        ref(SavedKind.Film, '00000000-0000-4000-8000-000000000000'),
      ],
      'viewer-1',
    );

    // `jobs` and `cinema` are both `launched: false`, so every route that
    // would render these is 404ed by `LaunchedFeaturesGuard`. No page to
    // navigate to means no availability to claim.
    expect(available.size).toBe(0);
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  describe('Studio cards', () => {
    const RELEASE_ID = '9e000000-0000-4000-8000-000000000001';
    const TRACK_ID = '9e000000-0000-4000-8000-000000000002';

    const predicatesOf = (queryBuilder: Record<string, jest.Mock>) =>
      (queryBuilder.andWhere?.mock.calls ?? []).map(
        ([predicate]) => predicate as string,
      );

    it('resolves a saved release through the Studio listening gate and the viewer grant', async () => {
      await build({ release: [RELEASE_ID] });

      const available = await service.availableRefs(
        [ref(SavedKind.StudioRelease, RELEASE_ID)],
        'viewer-1',
      );

      expect(available.has(`studio_release:${RELEASE_ID}`)).toBe(true);
      const queryBuilder = manager.createQueryBuilder.mock.results[0]!
        .value as Record<string, jest.Mock>;
      expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
        'release.subprofile',
        'persona',
      );
      expect(
        predicatesOf(queryBuilder).some((predicate) =>
          predicate.includes('content_moderation'),
        ),
      ).toBe(true);
      expect(
        predicatesOf(queryBuilder).some((predicate) =>
          predicate.includes('"studio_access_grants"'),
        ),
      ).toBe(true);
      expect(excludeBlocked).toHaveBeenCalledWith(
        queryBuilder,
        'viewer-1',
        '"persona"."user_id"',
      );
    });

    it('resolves a saved track through its release', async () => {
      await build({ track: [TRACK_ID] });

      const available = await service.availableRefs(
        [ref(SavedKind.StudioTrack, TRACK_ID)],
        'viewer-1',
      );

      expect(available.has(`studio_track:${TRACK_ID}`)).toBe(true);
      const queryBuilder = manager.createQueryBuilder.mock.results[0]!
        .value as Record<string, jest.Mock>;
      expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
        'track.release',
        'release',
      );
    });

    // Studio artist kinds: a draft episode a member saved stays unavailable
    // until it is published.
    it('resolves a saved episode only once it is published', async () => {
      await build({ track: [TRACK_ID] });

      await service.availableRefs(
        [ref(SavedKind.StudioTrack, TRACK_ID)],
        'viewer-1',
      );

      const queryBuilder = manager.createQueryBuilder.mock.results[0]!
        .value as Record<string, jest.Mock>;
      expect(predicatesOf(queryBuilder)).toContain(
        episodeReleasedSql('track', 'release'),
      );
    });

    it('answers nothing, without querying, for a signed-out viewer or an id that is no uuid', async () => {
      await build({ release: [RELEASE_ID] });
      expect(
        (
          await service.availableRefs(
            [ref(SavedKind.StudioRelease, RELEASE_ID)],
            null,
          )
        ).size,
      ).toBe(0);
      expect(
        (
          await service.availableRefs(
            [ref(SavedKind.StudioRelease, 'lisbon-at-four')],
            'viewer-1',
          )
        ).size,
      ).toBe(0);
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    // Studio v2: a saved playlist reads as available exactly when the viewer
    // could open it by link today.
    it('resolves a saved playlist through the playlist link rule and the viewer grant', async () => {
      const PLAYLIST_ID = '9e000000-0000-4000-8000-000000000003';
      await build({ playlist: [PLAYLIST_ID] });

      const available = await service.availableRefs(
        [ref(SavedKind.StudioPlaylist, PLAYLIST_ID)],
        'viewer-1',
      );

      expect(available.has(`studio_playlist:${PLAYLIST_ID}`)).toBe(true);
      const queryBuilder = manager.createQueryBuilder.mock.results[0]!
        .value as Record<string, jest.Mock>;
      const playlistRuleCall = queryBuilder.andWhere?.mock.calls.find(
        ([predicate]) =>
          String(predicate).includes('"playlist_connection"."status"'),
      );
      expect(playlistRuleCall?.[1]).toEqual({
        savedPlaylistViewerId: 'viewer-1',
      });
      expect(
        predicatesOf(queryBuilder).some((predicate) =>
          predicate.includes('"saved_playlist_grant"'),
        ),
      ).toBe(true);
      expect(excludeBlocked).toHaveBeenCalledWith(
        queryBuilder,
        'viewer-1',
        '"playlist"."user_id"',
      );
    });

    it('reads a saved playlist as unavailable once its owner is inactive or the persona creator is blocked either way', async () => {
      const PLAYLIST_ID = '9e000000-0000-4000-8000-000000000003';
      await build({ playlist: [PLAYLIST_ID] });

      await service.availableRefs(
        [ref(SavedKind.StudioPlaylist, PLAYLIST_ID)],
        'viewer-1',
      );

      const queryBuilder = manager.createQueryBuilder.mock.results[0]!
        .value as Record<string, jest.Mock>;
      const playlistRule = predicatesOf(queryBuilder).find((predicate) =>
        predicate.includes('"playlist_connection"."status"'),
      );
      expect(playlistRule).toContain(ownerHoldsGrantSql('playlist'));
      expect(playlistRule).toContain(`"playlist_owner"."status" = 'active'`);
      expect(excludeBlocked).toHaveBeenCalledWith(
        queryBuilder,
        'viewer-1',
        creditPersonaCreatorIdSql('playlist'),
        {
          unless: personaCreatorBlockExemptSql(
            'playlist',
            'savedPlaylistViewerId',
          ),
        },
      );
      expect(
        personaCreatorBlockExemptSql('playlist', 'savedPlaylistViewerId'),
      ).toContain('"playlist"."credit_subprofile_id" IS NULL');
    });

    it('reads a saved playlist as unavailable to a signed-out viewer, without querying', async () => {
      await build({ playlist: ['9e000000-0000-4000-8000-000000000003'] });
      const available = await service.availableRefs(
        [ref(SavedKind.StudioPlaylist, '9e000000-0000-4000-8000-000000000003')],
        null,
      );
      expect(available.size).toBe(0);
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    // Studio open demo pages: a saved release or track whose release staff
    // took down reads "withdrawn" in the library.
    describe('withdrawnRefs', () => {
      it('finds saved releases and tracks whose release staff took down, through the same grant and block gates', async () => {
        await build({ release: [RELEASE_ID], track: [TRACK_ID] });

        const withdrawn = await service.withdrawnRefs(
          [
            ref(SavedKind.StudioRelease, RELEASE_ID),
            ref(SavedKind.StudioTrack, TRACK_ID),
          ],
          'viewer-1',
        );

        expect([...withdrawn].sort()).toEqual([
          `studio_release:${RELEASE_ID}`,
          `studio_track:${TRACK_ID}`,
        ]);
        expect(manager.createQueryBuilder).toHaveBeenCalledTimes(2);
        for (const result of manager.createQueryBuilder.mock.results) {
          const queryBuilder = result.value as Record<string, jest.Mock>;
          const predicates = predicatesOf(queryBuilder);
          expect(predicates).toContain(
            withdrawnReleaseSql('release', 'persona'),
          );
          expect(
            predicates.some((predicate) =>
              predicate.includes('"studio_access_grants"'),
            ),
          ).toBe(true);
          expect(
            predicates.some((predicate) =>
              predicate.includes(':savedStudioPublished'),
            ),
          ).toBe(false);
          expect(excludeBlocked).toHaveBeenCalledWith(
            queryBuilder,
            'viewer-1',
            '"persona"."user_id"',
          );
        }
      });

      it('reports a release the query did not return as no reason at all', async () => {
        await build({ release: [] });
        const withdrawn = await service.withdrawnRefs(
          [ref(SavedKind.StudioRelease, RELEASE_ID)],
          'viewer-1',
        );
        expect(withdrawn.size).toBe(0);
      });

      it('asks nothing for a signed-out viewer, ids that are no uuid, or a page with no Studio release or track', async () => {
        await build({ release: [RELEASE_ID] });
        expect(
          (
            await service.withdrawnRefs(
              [ref(SavedKind.StudioRelease, RELEASE_ID)],
              null,
            )
          ).size,
        ).toBe(0);
        expect(
          (
            await service.withdrawnRefs(
              [ref(SavedKind.StudioRelease, 'lisbon-at-four')],
              'viewer-1',
            )
          ).size,
        ).toBe(0);
        expect(
          (
            await service.withdrawnRefs(
              [
                ref(SavedKind.Post, 'finding-a-gp'),
                ref(
                  SavedKind.StudioPlaylist,
                  '9e000000-0000-4000-8000-000000000003',
                ),
              ],
              'viewer-1',
            )
          ).size,
        ).toBe(0);
        expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      });
    });
  });
});

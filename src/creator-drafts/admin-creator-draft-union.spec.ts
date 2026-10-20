import { FeatureKey } from '../launchedFeatures';
import {
  buildCreatorDraftCountQuery,
  buildCreatorDraftPageQuery,
  enabledCreatorDraftKinds,
} from './admin-creator-draft-union';
import {
  CreatorDraftVisibility,
  NoticeGatedCreatorDraftKind,
} from './creator-drafts.constants';

const NOTICE = '2026-10-01T00:00:00.000Z';
const CUTOFF = new Date('2026-07-21T00:00:00.000Z');
const DRAFT_ID = 'c8200000-0000-4000-8000-000000000001';
const ALL_NULL: Record<NoticeGatedCreatorDraftKind, string | null> = {
  persona: null,
  studio_release: null,
  studio_episode: null,
  event: null,
  listing_edit: null,
  community: null,
};

const visibilityWith = (
  overrides: Partial<Record<NoticeGatedCreatorDraftKind, string | null>>,
  launched: FeatureKey[] = ['events', 'communities', 'listings', 'studio'],
): CreatorDraftVisibility => ({
  noticeLiveSince: { ...ALL_NULL, ...overrides },
  isFeatureLaunched: (feature) => launched.includes(feature),
});

describe('admin creator draft union', () => {
  it('drops a kind whose notice date is null or whose feature is off', () => {
    expect(
      enabledCreatorDraftKinds(undefined, visibilityWith({ event: NOTICE })),
    ).toEqual(['listing', 'event']);
    expect(
      enabledCreatorDraftKinds(
        undefined,
        visibilityWith({ event: NOTICE }, ['communities']),
      ),
    ).toEqual([]);
    expect(
      enabledCreatorDraftKinds('persona', visibilityWith({ persona: NOTICE })),
    ).toEqual(['persona']);
    expect(
      enabledCreatorDraftKinds('event', visibilityWith({ persona: NOTICE })),
    ).toEqual([]);
  });

  it('answers null with no kinds to read', () => {
    expect(
      buildCreatorDraftPageQuery(
        { kinds: [], noticeLiveSince: ALL_NULL, expiryCutoff: CUTOFF },
        1,
      ),
    ).toBeNull();
    expect(
      buildCreatorDraftCountQuery({
        kinds: [],
        noticeLiveSince: ALL_NULL,
        expiryCutoff: CUTOFF,
      }),
    ).toBeNull();
  });

  it('reads no branch for a gated kind whose notice date is null', () => {
    expect(
      buildCreatorDraftPageQuery(
        { kinds: ['event'], noticeLiveSince: ALL_NULL, expiryCutoff: CUTOFF },
        1,
      ),
    ).toBeNull();
  });

  it('orders newest first with kind and id as tie breaks and pages by twenty', () => {
    const query = buildCreatorDraftPageQuery(
      {
        kinds: ['listing', 'community'],
        noticeLiveSince: { ...ALL_NULL, community: NOTICE },
        expiryCutoff: CUTOFF,
      },
      3,
    )!;
    expect(query.sql).toMatch(/UNION ALL/);
    expect(query.sql).toMatch(
      /ORDER BY "last_saved_at" DESC, "kind" ASC, "id" DESC LIMIT \$\d+ OFFSET \$\d+$/,
    );
    expect(query.parameters.slice(-2)).toEqual([20, 40]);
    expect(query.parameters).toEqual(expect.arrayContaining([CUTOFF, NOTICE]));
  });

  it('adds an id filter to every branch for a detail read', () => {
    const query = buildCreatorDraftCountQuery({
      kinds: ['event'],
      noticeLiveSince: { ...ALL_NULL, event: NOTICE },
      expiryCutoff: CUTOFF,
      draftId: DRAFT_ID,
    })!;
    expect(query.sql).toMatch(/"stored"\."id" = \$\d+/);
    expect(query.parameters).toContain(DRAFT_ID);
  });

  it('numbers each placeholder once and keeps every value out of the SQL text', () => {
    const query = buildCreatorDraftPageQuery(
      {
        kinds: ['persona', 'studio_episode', 'listing_edit'],
        noticeLiveSince: {
          ...ALL_NULL,
          persona: NOTICE,
          studio_episode: NOTICE,
          listing_edit: NOTICE,
        },
        expiryCutoff: CUTOFF,
        draftId: DRAFT_ID,
      },
      1,
    )!;
    const placeholders = query.sql.match(/\$\d+/g) ?? [];
    expect(placeholders).toHaveLength(query.parameters.length);
    expect(new Set(placeholders).size).toBe(placeholders.length);
    expect(query.sql).not.toContain(DRAFT_ID);
    expect(query.sql).not.toContain(NOTICE);
    expect(query.sql.match(/UNION ALL/g)).toHaveLength(2);
    expect(query.sql).toMatch(/"persona"\."id" = \$\d+/);
    expect(query.sql).toMatch(/"track"\."id" = \$\d+/);
  });

  it('holds Studio branches to the persona rule, listing edits to an author who still manages the listing, and every branch to an author who is not deactivated', () => {
    const allKinds = {
      persona: NOTICE,
      studio_release: NOTICE,
      studio_episode: NOTICE,
      event: NOTICE,
      listing_edit: NOTICE,
      community: NOTICE,
    };
    const branchesOf = (sql: string): string[] =>
      sql
        .replace(/^SELECT \* FROM \(|\) AS "drafts".*$/g, '')
        .split(' UNION ALL ');
    const query = buildCreatorDraftPageQuery(
      {
        kinds: [
          'persona',
          'studio_release',
          'studio_episode',
          'listing',
          'event',
          'listing_edit',
          'community',
        ],
        noticeLiveSince: allKinds,
        expiryCutoff: CUTOFF,
      },
      1,
    )!;
    const branches = branchesOf(query.sql);
    expect(branches).toHaveLength(7);
    for (const branch of branches) {
      expect(branch).toContain(`"author"."status" <> 'deactivated'`);
      expect(branch).toMatch(
        /JOIN "users" "author" ON "author"\."id" = "\w+"\."user_id"/,
      );
    }
    const listingEditBranch = branches.find((branch) =>
      branch.includes(`'listing_edit'::text`),
    );
    expect(listingEditBranch).toContain(
      'EXISTS (SELECT 1 FROM "listings" "managed" WHERE "managed"."id" = "stored"."made_for_listing_id"',
    );
    expect(listingEditBranch).toContain(
      '"managed"."owner_id" = "stored"."user_id"',
    );
    expect(listingEditBranch).toContain(
      `"co_manager"."user_id" = "stored"."user_id" AND "co_manager"."status" = 'active'`,
    );
    for (const branch of branches) {
      if (branch === listingEditBranch) continue;
      expect(branch).not.toContain('"listing_co_managers"');
    }
    const studioBranches = branches.filter((branch) =>
      /'studio_(release|episode)'::text/.test(branch),
    );
    expect(studioBranches).toHaveLength(2);
    for (const branch of studioBranches) {
      expect(branch).toContain('"persona"."removed_at" IS NULL');
      expect(branch).toContain(`"persona"."visibility" <> 'private'`);
      expect(branch).toContain('"author"."id" = "persona"."user_id"');
    }
  });
});

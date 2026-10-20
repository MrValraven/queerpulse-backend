// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import {
  buildCreatorDraftCountQuery,
  buildCreatorDraftPageQuery,
  CreatorDraftScope,
  CreatorDraftUnionRow,
} from '../creator-drafts/admin-creator-draft-union';
import { AddCreatorDrafts1835000000000 } from '../migrations/1835000000000-AddCreatorDrafts';

/**
 * The Admin creator drafts union on real Postgres, over stub tables holding
 * only the columns the branches read. Skipped unless
 * `CREATOR_DRAFTS_DATABASE_URL` names a database whose name ends in `_test`
 * (it drops and rebuilds the schema). Run it with, for example:
 *
 *   CREATOR_DRAFTS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/creator_drafts_test \
 *     npx jest src/database/creator-drafts-union.postgres.spec.ts
 */
const DATABASE_URL = process.env.CREATOR_DRAFTS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const PERSONA_OWNER = 'c8a00000-0000-4000-8000-000000000001';
const LISTING_AUTHOR = 'c8a00000-0000-4000-8000-000000000002';
const STORED_AUTHOR = 'c8a00000-0000-4000-8000-000000000003';
const DEACTIVATED_AUTHOR = 'c8a00000-0000-4000-8000-000000000004';
const SUSPENDED_AUTHOR = 'c8a00000-0000-4000-8000-000000000005';

const COMMUNITY_ID = 'c8b00000-0000-4000-8000-000000000001';
const LIVE_LISTING_ID = 'c8b10000-0000-4000-8000-000000000001';
const GONE_LISTING_ID = 'c8b10000-0000-4000-8000-000000000002';
/** Owned by LISTING_AUTHOR; STORED_AUTHOR actively co-manages it. */
const CO_MANAGED_LISTING_ID = 'c8b10000-0000-4000-8000-000000000003';
/** Owned by LISTING_AUTHOR; STORED_AUTHOR's seat is only an invitation now. */
const LOST_LISTING_ID = 'c8b10000-0000-4000-8000-000000000004';

const PERSONA_DRAFT = 'c8c00000-0000-4000-8000-000000000001';
const PERSONA_PUBLISHED = 'c8c00000-0000-4000-8000-000000000002';
const PERSONA_PRIVATE = 'c8c00000-0000-4000-8000-000000000003';
const PERSONA_REMOVED = 'c8c00000-0000-4000-8000-000000000004';
const PERSONA_BEFORE_NOTICE = 'c8c00000-0000-4000-8000-000000000005';

const RELEASE_DRAFT = 'c8d00000-0000-4000-8000-000000000001';
const RELEASE_SCHEDULED = 'c8d00000-0000-4000-8000-000000000002';
const RELEASE_PUBLISHED_ALBUM = 'c8d00000-0000-4000-8000-000000000003';
const RELEASE_TAKEN_DOWN = 'c8d00000-0000-4000-8000-000000000004';
const SHOW_PUBLISHED = 'c8d00000-0000-4000-8000-000000000005';
const SHOW_DRAFT = 'c8d00000-0000-4000-8000-000000000006';
const RELEASE_ON_REMOVED_PERSONA = 'c8d00000-0000-4000-8000-000000000007';
const RELEASE_ON_PRIVATE_PERSONA = 'c8d00000-0000-4000-8000-000000000008';
const RELEASE_BEFORE_NOTICE = 'c8d00000-0000-4000-8000-000000000009';
const SHOW_ON_PRIVATE_PERSONA = 'c8d00000-0000-4000-8000-00000000000a';

const EPISODE_DRAFT = 'c8e00000-0000-4000-8000-000000000001';
const EPISODE_PUBLISHED = 'c8e00000-0000-4000-8000-000000000002';
const EPISODE_ON_DRAFT_SHOW = 'c8e00000-0000-4000-8000-000000000003';
const ALBUM_TRACK_UNPUBLISHED = 'c8e00000-0000-4000-8000-000000000004';
const EPISODE_ON_PRIVATE_PERSONA = 'c8e00000-0000-4000-8000-000000000005';
const EPISODE_BEFORE_NOTICE = 'c8e00000-0000-4000-8000-000000000006';

const LISTING_DRAFT_OLD = 'c8f00000-0000-4000-8000-000000000001';
const LISTING_DRAFT_TIE_FIRST = 'c8f00000-0000-4000-8000-000000000002';
const LISTING_DRAFT_TIE_SECOND = 'c8f00000-0000-4000-8000-000000000003';
const LISTING_DRAFT_DEACTIVATED_AUTHOR = 'c8f00000-0000-4000-8000-000000000004';

const EVENT_FOR_COMMUNITY = 'c8f10000-0000-4000-8000-000000000001';
const EVENT_FOR_LISTING = 'c8f10000-0000-4000-8000-000000000002';
const EVENT_PERSONAL = 'c8f10000-0000-4000-8000-000000000003';
const EVENT_BEFORE_NOTICE = 'c8f10000-0000-4000-8000-000000000004';
const LISTING_EDIT_LIVE = 'c8f10000-0000-4000-8000-000000000005';
const LISTING_EDIT_GONE = 'c8f10000-0000-4000-8000-000000000006';
const COMMUNITY_DRAFT = 'c8f10000-0000-4000-8000-000000000007';
const COMMUNITY_EXPIRED = 'c8f10000-0000-4000-8000-000000000008';
const EVENT_EXPIRED = 'c8f10000-0000-4000-8000-000000000009';
const LISTING_EDIT_EXPIRED = 'c8f10000-0000-4000-8000-00000000000a';
const LISTING_EDIT_BEFORE_NOTICE = 'c8f10000-0000-4000-8000-00000000000b';
const COMMUNITY_BEFORE_NOTICE = 'c8f10000-0000-4000-8000-00000000000c';
const COMMUNITY_DEACTIVATED_AUTHOR = 'c8f10000-0000-4000-8000-00000000000d';
const COMMUNITY_SUSPENDED_AUTHOR = 'c8f10000-0000-4000-8000-00000000000e';
const LISTING_EDIT_CO_MANAGED = 'c8f10000-0000-4000-8000-00000000000f';
const LISTING_EDIT_LOST_MANAGEMENT = 'c8f10000-0000-4000-8000-000000000010';

// The persona notice sits before the expiry cutoff, every other kind's after
// it. Pre-notice rows are saved after the cutoff, so FULL_SCOPE drops them on
// the notice alone. Expired rows also predate the late notice, so
// EXPIRY_SCOPE moves the stored kinds to the early notice to drop them on
// expiry alone.
const EARLY_NOTICE = '2025-06-01T00:00:00.000Z';
const LATE_NOTICE = '2026-02-01T00:00:00.000Z';
const EXPIRY_CUTOFF = new Date('2026-01-01T00:00:00.000Z');
const BEFORE_EARLY_NOTICE = '2025-05-01T00:00:00.000Z';
const EXPIRED = '2025-12-01T00:00:00.000Z';
const BEFORE_LATE_NOTICE = '2026-01-15T00:00:00.000Z';
const RECENT = '2026-03-01T00:00:00.000Z';
const TIE = '2026-03-05T00:00:00.000Z';

const FULL_SCOPE: CreatorDraftScope = {
  kinds: [
    'persona',
    'studio_release',
    'studio_episode',
    'listing',
    'event',
    'listing_edit',
    'community',
  ],
  noticeLiveSince: {
    persona: EARLY_NOTICE,
    studio_release: LATE_NOTICE,
    studio_episode: LATE_NOTICE,
    event: LATE_NOTICE,
    listing_edit: LATE_NOTICE,
    community: LATE_NOTICE,
  },
  expiryCutoff: EXPIRY_CUTOFF,
};

const EXPIRY_SCOPE: CreatorDraftScope = {
  ...FULL_SCOPE,
  noticeLiveSince: {
    ...FULL_SCOPE.noticeLiveSince,
    event: EARLY_NOTICE,
    listing_edit: EARLY_NOTICE,
    community: EARLY_NOTICE,
  },
};

const IN_SCOPE_KEYS = [
  `persona:${PERSONA_DRAFT}`,
  `studio_release:${RELEASE_DRAFT}`,
  `studio_release:${RELEASE_SCHEDULED}`,
  `studio_release:${SHOW_DRAFT}`,
  `studio_episode:${EPISODE_DRAFT}`,
  `listing:${LISTING_DRAFT_OLD}`,
  `listing:${LISTING_DRAFT_TIE_FIRST}`,
  `listing:${LISTING_DRAFT_TIE_SECOND}`,
  `event:${EVENT_FOR_COMMUNITY}`,
  `event:${EVENT_FOR_LISTING}`,
  `listing_edit:${LISTING_EDIT_LIVE}`,
  `listing_edit:${LISTING_EDIT_CO_MANAGED}`,
  `community:${COMMUNITY_DRAFT}`,
  `community:${COMMUNITY_SUSPENDED_AUTHOR}`,
];

/** Stored rows FULL_SCOPE drops on the notice date and EXPIRY_SCOPE keeps. */
const STORED_BEFORE_LATE_NOTICE_KEYS = [
  `event:${EVENT_BEFORE_NOTICE}`,
  `listing_edit:${LISTING_EDIT_BEFORE_NOTICE}`,
  `community:${COMMUNITY_BEFORE_NOTICE}`,
];

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

const keyOf = (row: CreatorDraftUnionRow): string => `${row.kind}:${row.id}`;

describeWithDatabase('Admin creator drafts union on real Postgres', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  const pageRows = async (
    scope: CreatorDraftScope,
  ): Promise<CreatorDraftUnionRow[]> => {
    const query = buildCreatorDraftPageQuery(scope, 1)!;
    return dataSource.query(query.sql, query.parameters);
  };

  const insertPersona = (
    id: string,
    status: string,
    visibility: string,
    updatedAt: string,
    removedAt: string | null = null,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "subprofiles" ("id", "user_id", "status", "removed_at", "visibility", "updated_at") VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, PERSONA_OWNER, status, removedAt, visibility, updatedAt],
    );

  const insertRelease = (
    id: string,
    status: string,
    type: string,
    subprofileId: string = PERSONA_PUBLISHED,
    updatedAt: string = RECENT,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "status", "type", "updated_at") VALUES ($1, $2, $3, $4, $5)`,
      [id, subprofileId, status, type, updatedAt],
    );

  const insertTrack = (
    id: string,
    releaseId: string,
    publishedAt: string | null,
    updatedAt: string = RECENT,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "published_at", "updated_at") VALUES ($1, $2, $3, $4)`,
      [id, releaseId, publishedAt, updatedAt],
    );

  const insertListingDraft = (
    id: string,
    updatedAt: string,
    authorId: string = LISTING_AUTHOR,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "listing_drafts" ("id", "user_id", "updated_at") VALUES ($1, $2, $3)`,
      [id, authorId, updatedAt],
    );

  const insertStored = (
    id: string,
    kind: 'event' | 'listing_edit' | 'community',
    updatedAt: string,
    madeFor: { communityId?: string; listingId?: string } = {},
    authorId: string = STORED_AUTHOR,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "creator_drafts" ("id", "user_id", "kind", "slot_key", "payload", "payload_version", "made_for_community_id", "made_for_listing_id", "updated_at") VALUES ($1, $2, $3, $4, '{}', 1, $5, $6, $7)`,
      [
        id,
        authorId,
        kind,
        id,
        madeFor.communityId ?? null,
        madeFor.listingId ?? null,
        updatedAt,
      ],
    );

  beforeAll(async () => {
    refuseUnlessTestDatabase(DATABASE_URL!);
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [],
      dropSchema: true,
      synchronize: false,
    });
    await dataSource.initialize();
    await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await dataSource.query(
      `CREATE TABLE "users" ("id" uuid PRIMARY KEY, "status" text NOT NULL DEFAULT 'active')`,
    );
    await dataSource.query(
      `CREATE TABLE "communities" ("id" uuid PRIMARY KEY)`,
    );
    await dataSource.query(
      `CREATE TABLE "listings" ("id" uuid PRIMARY KEY, "owner_id" uuid)`,
    );
    await dataSource.query(
      `CREATE TABLE "listing_co_managers" ("listing_id" uuid NOT NULL, "user_id" uuid NOT NULL, "status" text NOT NULL)`,
    );
    await dataSource.query(
      `CREATE TABLE "subprofiles" ("id" uuid PRIMARY KEY, "user_id" uuid NOT NULL, "status" text NOT NULL, "removed_at" timestamptz, "visibility" text NOT NULL, "updated_at" timestamptz NOT NULL)`,
    );
    await dataSource.query(
      `CREATE TABLE "studio_releases" ("id" uuid PRIMARY KEY, "subprofile_id" uuid NOT NULL, "status" text NOT NULL, "type" text NOT NULL, "updated_at" timestamptz NOT NULL)`,
    );
    await dataSource.query(
      `CREATE TABLE "studio_tracks" ("id" uuid PRIMARY KEY, "release_id" uuid NOT NULL, "published_at" timestamptz, "updated_at" timestamptz NOT NULL)`,
    );
    await dataSource.query(
      `CREATE TABLE "listing_drafts" ("id" uuid PRIMARY KEY, "user_id" uuid NOT NULL, "updated_at" timestamptz NOT NULL)`,
    );
    queryRunner = dataSource.createQueryRunner();
    await new AddCreatorDrafts1835000000000().up(queryRunner);

    for (const [userId, status] of [
      [PERSONA_OWNER, 'active'],
      [LISTING_AUTHOR, 'active'],
      [STORED_AUTHOR, 'active'],
      [DEACTIVATED_AUTHOR, 'deactivated'],
      [SUSPENDED_AUTHOR, 'suspended'],
    ]) {
      await dataSource.query(
        `INSERT INTO "users" ("id", "status") VALUES ($1, $2)`,
        [userId, status],
      );
    }
    await dataSource.query(`INSERT INTO "communities" ("id") VALUES ($1)`, [
      COMMUNITY_ID,
    ]);
    await dataSource.query(
      `INSERT INTO "listings" ("id", "owner_id") VALUES ($1, $3), ($2, $3), ($4, $5), ($6, $5)`,
      [
        LIVE_LISTING_ID,
        GONE_LISTING_ID,
        STORED_AUTHOR,
        CO_MANAGED_LISTING_ID,
        LISTING_AUTHOR,
        LOST_LISTING_ID,
      ],
    );
    await dataSource.query(
      `INSERT INTO "listing_co_managers" ("listing_id", "user_id", "status") VALUES ($1, $3, 'active'), ($2, $3, 'invited')`,
      [CO_MANAGED_LISTING_ID, LOST_LISTING_ID, STORED_AUTHOR],
    );

    await insertPersona(PERSONA_DRAFT, 'draft', 'open', RECENT);
    await insertPersona(PERSONA_PUBLISHED, 'published', 'open', RECENT);
    await insertPersona(PERSONA_PRIVATE, 'draft', 'private', RECENT);
    await insertPersona(PERSONA_REMOVED, 'draft', 'network', RECENT, RECENT);
    await insertPersona(
      PERSONA_BEFORE_NOTICE,
      'draft',
      'open',
      BEFORE_EARLY_NOTICE,
    );

    await insertRelease(RELEASE_DRAFT, 'draft', 'album');
    await insertRelease(RELEASE_SCHEDULED, 'scheduled', 'single');
    await insertRelease(RELEASE_PUBLISHED_ALBUM, 'published', 'album');
    await insertRelease(RELEASE_TAKEN_DOWN, 'taken_down', 'album');
    await insertRelease(SHOW_PUBLISHED, 'published', 'podcast');
    await insertRelease(SHOW_DRAFT, 'draft', 'podcast');
    await insertRelease(
      RELEASE_ON_REMOVED_PERSONA,
      'draft',
      'album',
      PERSONA_REMOVED,
    );
    await insertRelease(
      RELEASE_ON_PRIVATE_PERSONA,
      'draft',
      'album',
      PERSONA_PRIVATE,
    );
    await insertRelease(
      RELEASE_BEFORE_NOTICE,
      'draft',
      'album',
      PERSONA_PUBLISHED,
      BEFORE_LATE_NOTICE,
    );
    await insertRelease(
      SHOW_ON_PRIVATE_PERSONA,
      'published',
      'podcast',
      PERSONA_PRIVATE,
    );

    await insertTrack(EPISODE_DRAFT, SHOW_PUBLISHED, null);
    await insertTrack(EPISODE_PUBLISHED, SHOW_PUBLISHED, RECENT);
    await insertTrack(EPISODE_ON_DRAFT_SHOW, SHOW_DRAFT, null);
    await insertTrack(ALBUM_TRACK_UNPUBLISHED, RELEASE_PUBLISHED_ALBUM, null);
    await insertTrack(
      EPISODE_ON_PRIVATE_PERSONA,
      SHOW_ON_PRIVATE_PERSONA,
      null,
    );
    await insertTrack(
      EPISODE_BEFORE_NOTICE,
      SHOW_PUBLISHED,
      null,
      BEFORE_LATE_NOTICE,
    );

    // Saved before every notice date: listing drafts are exempt and never expire.
    await insertListingDraft(LISTING_DRAFT_OLD, BEFORE_EARLY_NOTICE);
    await insertListingDraft(LISTING_DRAFT_TIE_FIRST, TIE);
    await insertListingDraft(LISTING_DRAFT_TIE_SECOND, TIE);
    await insertListingDraft(
      LISTING_DRAFT_DEACTIVATED_AUTHOR,
      RECENT,
      DEACTIVATED_AUTHOR,
    );

    await insertStored(EVENT_FOR_COMMUNITY, 'event', TIE, {
      communityId: COMMUNITY_ID,
    });
    await insertStored(EVENT_FOR_LISTING, 'event', RECENT, {
      listingId: LIVE_LISTING_ID,
    });
    await insertStored(EVENT_PERSONAL, 'event', RECENT);
    await insertStored(EVENT_BEFORE_NOTICE, 'event', BEFORE_LATE_NOTICE, {
      communityId: COMMUNITY_ID,
    });
    await insertStored(EVENT_EXPIRED, 'event', EXPIRED, {
      communityId: COMMUNITY_ID,
    });
    await insertStored(LISTING_EDIT_LIVE, 'listing_edit', RECENT, {
      listingId: LIVE_LISTING_ID,
    });
    await insertStored(LISTING_EDIT_GONE, 'listing_edit', RECENT, {
      listingId: GONE_LISTING_ID,
    });
    await insertStored(LISTING_EDIT_CO_MANAGED, 'listing_edit', RECENT, {
      listingId: CO_MANAGED_LISTING_ID,
    });
    await insertStored(LISTING_EDIT_LOST_MANAGEMENT, 'listing_edit', RECENT, {
      listingId: LOST_LISTING_ID,
    });
    await dataSource.query(`DELETE FROM "listings" WHERE "id" = $1`, [
      GONE_LISTING_ID,
    ]);
    await insertStored(
      LISTING_EDIT_BEFORE_NOTICE,
      'listing_edit',
      BEFORE_LATE_NOTICE,
      { listingId: LIVE_LISTING_ID },
    );
    await insertStored(LISTING_EDIT_EXPIRED, 'listing_edit', EXPIRED, {
      listingId: LIVE_LISTING_ID,
    });
    await insertStored(COMMUNITY_DRAFT, 'community', TIE);
    await insertStored(COMMUNITY_EXPIRED, 'community', EXPIRED);
    await insertStored(
      COMMUNITY_BEFORE_NOTICE,
      'community',
      BEFORE_LATE_NOTICE,
    );
    await insertStored(
      COMMUNITY_DEACTIVATED_AUTHOR,
      'community',
      RECENT,
      {},
      DEACTIVATED_AUTHOR,
    );
    await insertStored(
      COMMUNITY_SUSPENDED_AUTHOR,
      'community',
      RECENT,
      {},
      SUSPENDED_AUTHOR,
    );
  });

  afterAll(async () => {
    await queryRunner?.release();
    await dataSource?.destroy();
  });

  it('lists only in-scope rows across the five tables', async () => {
    const query = buildCreatorDraftPageQuery(FULL_SCOPE, 1)!;
    const rows: CreatorDraftUnionRow[] = await dataSource.query(
      query.sql,
      query.parameters,
    );
    expect(rows.map(keyOf).sort()).toEqual([...IN_SCOPE_KEYS].sort());
    // out of scope: a published persona, a private persona, a removed persona,
    // a persona saved before its notice date, a published album, a taken-down
    // release, a release on a removed persona, a release on a private persona,
    // a release saved before its notice date, a published episode, an episode
    // on a draft show, an episode on a private persona's show, an episode saved
    // before its notice date, an unpublished track on an album, a personal
    // event draft, an expired event, listing edit and community draft, a
    // listing edit whose listing is gone, a listing edit whose author no longer
    // owns or actively co-manages the listing, an event, listing edit and community
    // draft saved before their notice date, and a listing draft and a
    // community draft whose author is deactivated (a suspended author stays)
    const ownerById = new Map(rows.map((row) => [row.id, row.owner_user_id]));
    expect(ownerById.get(PERSONA_DRAFT)).toBe(PERSONA_OWNER);
    expect(ownerById.get(RELEASE_DRAFT)).toBe(PERSONA_OWNER);
    expect(ownerById.get(EPISODE_DRAFT)).toBe(PERSONA_OWNER);
    expect(ownerById.get(LISTING_DRAFT_OLD)).toBe(LISTING_AUTHOR);
    expect(ownerById.get(COMMUNITY_DRAFT)).toBe(STORED_AUTHOR);
    expect(ownerById.get(COMMUNITY_SUSPENDED_AUTHOR)).toBe(SUSPENDED_AUTHOR);
    expect(rows.every((row) => row.last_saved_at instanceof Date)).toBe(true);
  });

  it('drops expired stored rows on expiry alone', async () => {
    const rows = await pageRows(EXPIRY_SCOPE);
    expect(rows.map(keyOf).sort()).toEqual(
      [...IN_SCOPE_KEYS, ...STORED_BEFORE_LATE_NOTICE_KEYS].sort(),
    );
    const listedIds = new Set(rows.map((row) => row.id));
    for (const expiredId of [
      EVENT_EXPIRED,
      LISTING_EDIT_EXPIRED,
      COMMUNITY_EXPIRED,
    ]) {
      expect(listedIds.has(expiredId)).toBe(false);
    }
  });

  it('counts the same rows the page lists', async () => {
    const count = buildCreatorDraftCountQuery(FULL_SCOPE)!;
    const countRows: { total: number }[] = await dataSource.query(
      count.sql,
      count.parameters,
    );
    expect(countRows).toHaveLength(1);
    expect(countRows[0]?.total).toBe(IN_SCOPE_KEYS.length);
  });

  it('orders by last saved time, then kind, then id', async () => {
    const rows = await pageRows(FULL_SCOPE);
    const expected = [...rows].sort(
      (left, right) =>
        right.last_saved_at.getTime() - left.last_saved_at.getTime() ||
        left.kind.localeCompare(right.kind) ||
        (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
    );
    expect(rows.map(keyOf)).toEqual(expected.map(keyOf));
    expect(rows.slice(0, 4).map(keyOf)).toEqual([
      `community:${COMMUNITY_DRAFT}`,
      `event:${EVENT_FOR_COMMUNITY}`,
      `listing:${LISTING_DRAFT_TIE_SECOND}`,
      `listing:${LISTING_DRAFT_TIE_FIRST}`,
    ]);
  });

  it('finds one in-scope draft by id and none for an out-of-scope id', async () => {
    const found = await pageRows({
      ...FULL_SCOPE,
      draftId: EVENT_FOR_COMMUNITY,
    });
    expect(found.map(keyOf)).toEqual([`event:${EVENT_FOR_COMMUNITY}`]);
    for (const outOfScopeId of [
      EVENT_PERSONAL,
      PERSONA_PRIVATE,
      COMMUNITY_EXPIRED,
      RELEASE_ON_PRIVATE_PERSONA,
      COMMUNITY_DEACTIVATED_AUTHOR,
      LISTING_DRAFT_DEACTIVATED_AUTHOR,
      LISTING_EDIT_LOST_MANAGEMENT,
    ]) {
      await expect(
        pageRows({ ...FULL_SCOPE, draftId: outOfScopeId }),
      ).resolves.toEqual([]);
    }
  });

  it('reads no rows of a kind left out of the scope', async () => {
    const rows = await pageRows({ ...FULL_SCOPE, kinds: ['listing'] });
    expect(rows.map(keyOf).sort()).toEqual(
      IN_SCOPE_KEYS.filter((key) => key.startsWith('listing:')).sort(),
    );
  });
});

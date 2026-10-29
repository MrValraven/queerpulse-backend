// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  forgetSalesOfPersona,
  StudioSalesUnlinkOutcome,
} from '../studio/studio-purchases-unlink';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Contract 4.7 on real Postgres: what an artist persona unlink does to its
 * sales, and how the kept files outlive the re-key of its releases and
 * tracks. Skipped unless `STUDIO_MIGRATIONS_DATABASE_URL` names a database
 * whose name ends in `_test` (it drops and synchronizes the schema from the
 * entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const ARTIST = 'c1000000-0000-4000-8000-000000000001';
const CO_OWNER = 'c1000000-0000-4000-8000-000000000002';
const ALBUM_BUYER = 'c1000000-0000-4000-8000-000000000003';
const TRACK_BUYER = 'c1000000-0000-4000-8000-000000000004';
const PENDING_BUYER = 'c1000000-0000-4000-8000-000000000005';
const DECLINED_BUYER = 'c1000000-0000-4000-8000-000000000006';
const OTHER_ARTIST = 'c1000000-0000-4000-8000-000000000007';
const USER_IDS = [
  ARTIST,
  CO_OWNER,
  ALBUM_BUYER,
  TRACK_BUYER,
  PENDING_BUYER,
  DECLINED_BUYER,
  OTHER_ARTIST,
];

const MUSIC_PERSONA = 'c2000000-0000-4000-8000-000000000001';
const OTHER_PERSONA = 'c2000000-0000-4000-8000-000000000002';

const ALBUM_RELEASE = 'c3000000-0000-4000-8000-000000000001';
const SINGLE_RELEASE = 'c3000000-0000-4000-8000-000000000002';
const OTHER_RELEASE = 'c3000000-0000-4000-8000-000000000003';

const PLAYABLE_TRACK = 'c4000000-0000-4000-8000-000000000001';
const WITHHELD_TRACK = 'c4000000-0000-4000-8000-000000000002';
const SILENT_TRACK = 'c4000000-0000-4000-8000-000000000003';
const SINGLE_TRACK = 'c4000000-0000-4000-8000-000000000004';
const OTHER_TRACK = 'c4000000-0000-4000-8000-000000000005';

const PLAYABLE_AUDIO_KEY = 'studio-audio/unlink/harbour.mp3';

const ALBUM_PURCHASE = 'c5000000-0000-4000-8000-000000000001';
const TRACK_PURCHASE = 'c5000000-0000-4000-8000-000000000002';
const PENDING_PURCHASE = 'c5000000-0000-4000-8000-000000000003';
const DECLINED_PURCHASE = 'c5000000-0000-4000-8000-000000000004';
const WALL_PURCHASE = 'c5000000-0000-4000-8000-000000000005';
const OTHER_PENDING_PURCHASE = 'c5000000-0000-4000-8000-000000000006';

const DECLINED_AT = '2026-10-20T10:00:00.000Z';
const CONFIRMED_AT = '2026-10-21T10:00:00.000Z';

interface PurchaseFixture {
  id: string;
  buyerUserId: string;
  subprofileId: string;
  artistName: string;
  itemKind: 'release' | 'track';
  releaseId: string | null;
  trackId: string | null;
  itemTitle: string;
  amountCents: number;
  referenceCode: string;
  status: 'pending' | 'confirmed' | 'declined';
  declineReason: string | null;
  decidedAt: string | null;
  isOnWall: boolean;
  isShownAsPersona: boolean;
  shownAsSubprofileId: string | null;
}

const PURCHASES: PurchaseFixture[] = [
  {
    id: ALBUM_PURCHASE,
    buyerUserId: ALBUM_BUYER,
    subprofileId: MUSIC_PERSONA,
    artistName: 'Harbour Lights',
    itemKind: 'release',
    releaseId: ALBUM_RELEASE,
    trackId: null,
    itemTitle: 'Low tide',
    amountCents: 800,
    referenceCode: 'AAAAAA',
    status: 'confirmed',
    declineReason: null,
    decidedAt: CONFIRMED_AT,
    isOnWall: true,
    isShownAsPersona: false,
    shownAsSubprofileId: null,
  },
  {
    id: TRACK_PURCHASE,
    buyerUserId: TRACK_BUYER,
    subprofileId: MUSIC_PERSONA,
    artistName: 'Harbour Lights',
    itemKind: 'track',
    releaseId: null,
    trackId: PLAYABLE_TRACK,
    itemTitle: 'Harbour',
    amountCents: 150,
    referenceCode: 'BBBBBB',
    status: 'confirmed',
    declineReason: null,
    decidedAt: CONFIRMED_AT,
    isOnWall: false,
    isShownAsPersona: false,
    shownAsSubprofileId: null,
  },
  {
    id: PENDING_PURCHASE,
    buyerUserId: PENDING_BUYER,
    subprofileId: MUSIC_PERSONA,
    artistName: 'Harbour Lights',
    itemKind: 'release',
    releaseId: ALBUM_RELEASE,
    trackId: null,
    itemTitle: 'Low tide',
    amountCents: 800,
    referenceCode: 'CCCCCC',
    status: 'pending',
    declineReason: null,
    decidedAt: null,
    isOnWall: false,
    isShownAsPersona: false,
    shownAsSubprofileId: null,
  },
  {
    id: DECLINED_PURCHASE,
    buyerUserId: DECLINED_BUYER,
    subprofileId: MUSIC_PERSONA,
    artistName: 'Harbour Lights',
    itemKind: 'release',
    releaseId: ALBUM_RELEASE,
    trackId: null,
    itemTitle: 'Low tide',
    amountCents: 800,
    referenceCode: 'DDDDDD',
    status: 'declined',
    declineReason: 'payment_not_found',
    decidedAt: DECLINED_AT,
    isOnWall: false,
    isShownAsPersona: false,
    shownAsSubprofileId: null,
  },
  // The co-owner bought from another artist and shows on that wall as the
  // persona being unlinked.
  {
    id: WALL_PURCHASE,
    buyerUserId: CO_OWNER,
    subprofileId: OTHER_PERSONA,
    artistName: 'Tram 28',
    itemKind: 'release',
    releaseId: OTHER_RELEASE,
    trackId: null,
    itemTitle: 'Tram at dawn',
    amountCents: 500,
    referenceCode: 'EEEEEE',
    status: 'confirmed',
    declineReason: null,
    decidedAt: CONFIRMED_AT,
    isOnWall: true,
    isShownAsPersona: true,
    shownAsSubprofileId: MUSIC_PERSONA,
  },
  {
    id: OTHER_PENDING_PURCHASE,
    buyerUserId: ALBUM_BUYER,
    subprofileId: OTHER_PERSONA,
    artistName: 'Tram 28',
    itemKind: 'track',
    releaseId: null,
    trackId: OTHER_TRACK,
    itemTitle: 'Tram solo',
    amountCents: 200,
    referenceCode: 'FFFFFF',
    status: 'pending',
    declineReason: null,
    decidedAt: null,
    isOnWall: false,
    isShownAsPersona: false,
    shownAsSubprofileId: null,
  },
];

interface PurchaseRow {
  id: string;
  subprofile_id: string | null;
  release_id: string | null;
  track_id: string | null;
  artist_name: string;
  item_title: string;
  status: string;
  decided_at: Date | null;
  is_on_wall: boolean;
  is_shown_as_persona: boolean;
  shown_as_subprofile_id: string | null;
}

interface KeptTrackRow {
  id: string;
  title: string;
  duration_seconds: number | null;
  audio_content_type: string;
  source_audio_key: string | null;
  audio_key: string | null;
  copy_attempts: number;
}

interface KeptLinkRow {
  purchase_id: string;
  kept_track_id: string;
  position: number;
}

interface PriceRow {
  id: string;
  price_mode: string;
  price_cents: number | null;
}

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio purchases persona unlink on real Postgres', () => {
  let dataSource: DataSource;

  const forgetSales = (): Promise<StudioSalesUnlinkOutcome> =>
    dataSource.transaction((manager) =>
      forgetSalesOfPersona(manager, MUSIC_PERSONA),
    );

  const purchaseRows = (): Promise<PurchaseRow[]> =>
    dataSource.query(
      `SELECT "id", "subprofile_id", "release_id", "track_id", "artist_name", "item_title",
              "status"::text AS "status", "decided_at", "is_on_wall", "is_shown_as_persona",
              "shown_as_subprofile_id"
         FROM "studio_purchases"
        ORDER BY "id"`,
    );

  const purchaseRow = async (
    purchaseId: string,
  ): Promise<PurchaseRow | undefined> =>
    (await purchaseRows()).find((row) => row.id === purchaseId);

  const keptTrackRows = (): Promise<KeptTrackRow[]> =>
    dataSource.query(
      `SELECT "id", "title", "duration_seconds", "audio_content_type", "source_audio_key",
              "audio_key", "copy_attempts"
         FROM "studio_kept_tracks"
        ORDER BY "id"`,
    );

  const keptLinkRows = (): Promise<KeptLinkRow[]> =>
    dataSource.query(
      `SELECT "purchase_id", "kept_track_id", "position"
         FROM "studio_purchase_kept_tracks"
        ORDER BY "purchase_id", "kept_track_id"`,
    );

  const releasePriceRows = (): Promise<PriceRow[]> =>
    dataSource.query(
      `SELECT "id", "price_mode"::text AS "price_mode", "price_cents"
         FROM "studio_releases"
        ORDER BY "id"`,
    );

  const trackPriceRows = (): Promise<PriceRow[]> =>
    dataSource.query(
      `SELECT "id", "price_mode"::text AS "price_mode", "price_cents"
         FROM "studio_tracks"
        ORDER BY "id"`,
    );

  const paymentMethodPersonaIds = async (): Promise<string[]> => {
    const rows: { subprofile_id: string }[] = await dataSource.query(
      `SELECT "subprofile_id" FROM "studio_payment_methods" ORDER BY "subprofile_id", "position"`,
    );
    return rows.map((row) => row.subprofile_id);
  };

  beforeAll(async () => {
    refuseUnlessTestDatabase(DATABASE_URL!);
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [`${__dirname}/../**/*.entity.ts`],
      namingStrategy: new SnakeNamingStrategy(),
      dropSchema: true,
      synchronize: true,
    });
    await dataSource.initialize();
    // The entity marks these two `synchronize: false`; copied from
    // `1838000000000-AddStudioPurchases`.
    await dataSource.query(
      `CREATE INDEX "IDX_studio_purchases_buyer_created_at" ON "studio_purchases" ("buyer_user_id", "created_at" DESC, "id" DESC)`,
    );
    await dataSource.query(
      `CREATE INDEX "IDX_studio_purchases_subprofile_decided_at" ON "studio_purchases" ("subprofile_id", "decided_at" DESC, "id" DESC) WHERE "status" = 'confirmed'`,
    );

    await dataSource.getRepository(User).insert(
      USER_IDS.map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.getRepository(Subprofile).insert([
      {
        id: MUSIC_PERSONA,
        userId: ARTIST,
        slug: 'harbour-lights',
        handle: 'harbour-lights',
        displayName: 'Harbour Lights',
        kind: SubprofileKind.Musician,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      },
      {
        id: OTHER_PERSONA,
        userId: OTHER_ARTIST,
        slug: 'tram-28',
        handle: 'tram-28',
        displayName: 'Tram 28',
        kind: SubprofileKind.Dj,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      },
    ]);
    await dataSource.getRepository(SubprofileMember).insert([
      { subprofileId: MUSIC_PERSONA, userId: ARTIST },
      { subprofileId: MUSIC_PERSONA, userId: CO_OWNER },
      { subprofileId: OTHER_PERSONA, userId: OTHER_ARTIST },
    ]);
  });

  beforeEach(async () => {
    await dataSource.query(
      `INSERT INTO "studio_payment_methods" ("subprofile_id", "kind", "value", "position")
       VALUES ($1, 'link', 'https://pay.example.test/harbour-lights', 0),
              ($1, 'mbway', '+351910000000', 1),
              ($2, 'link', 'https://pay.example.test/tram-28', 0)`,
      [MUSIC_PERSONA, OTHER_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at", "price_mode", "price_cents")
       VALUES ($1, $4, 'Low tide', 'album', 'published', now(), 'fixed', 800),
              ($2, $4, 'Lights out', 'single', 'published', now(), 'name_your_price', 0),
              ($3, $5, 'Tram at dawn', 'album', 'published', now(), 'fixed', 500)`,
      [
        ALBUM_RELEASE,
        SINGLE_RELEASE,
        OTHER_RELEASE,
        MUSIC_PERSONA,
        OTHER_PERSONA,
      ],
    );
    // The album: one playable track, one withheld, one with no audio yet.
    await dataSource.query(
      `INSERT INTO "studio_tracks"
         ("id", "release_id", "position", "title", "audio_key", "audio_content_type", "duration_seconds", "withheld_at", "price_mode", "price_cents")
       VALUES ($1, $6, 1, 'Harbour', $9, 'audio/mpeg', 200, NULL, 'fixed', 150),
              ($2, $6, 2, 'Lights', 'studio-audio/unlink/lights.mp3', 'audio/mpeg', 210, now(), 'fixed', 150),
              ($3, $6, 3, 'Tide', NULL, NULL, NULL, NULL, 'not_for_sale', NULL),
              ($4, $7, 1, 'Lights out', 'studio-audio/unlink/lights-out.m4a', 'audio/mp4', 180, NULL, 'name_your_price', 0),
              ($5, $8, 1, 'Tram solo', 'studio-audio/unlink/tram.mp3', 'audio/mpeg', 240, NULL, 'fixed', 200)`,
      [
        PLAYABLE_TRACK,
        WITHHELD_TRACK,
        SILENT_TRACK,
        SINGLE_TRACK,
        OTHER_TRACK,
        ALBUM_RELEASE,
        SINGLE_RELEASE,
        OTHER_RELEASE,
        PLAYABLE_AUDIO_KEY,
      ],
    );
    for (const purchase of PURCHASES) {
      await dataSource.query(
        `INSERT INTO "studio_purchases"
           ("id", "buyer_user_id", "subprofile_id", "artist_name", "item_kind", "release_id", "track_id",
            "item_title", "amount_cents", "reference_code", "status", "decline_reason", "decided_at",
            "is_on_wall", "is_shown_as_persona", "shown_as_subprofile_id")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14, $15, $16)`,
        [
          purchase.id,
          purchase.buyerUserId,
          purchase.subprofileId,
          purchase.artistName,
          purchase.itemKind,
          purchase.releaseId,
          purchase.trackId,
          purchase.itemTitle,
          purchase.amountCents,
          purchase.referenceCode,
          purchase.status,
          purchase.declineReason,
          purchase.decidedAt,
          purchase.isOnWall,
          purchase.isShownAsPersona,
          purchase.shownAsSubprofileId,
        ],
      );
    }
  });

  afterEach(async () => {
    await dataSource.query(
      `TRUNCATE "studio_purchase_kept_tracks", "studio_kept_tracks", "studio_purchases",
                "studio_payment_methods", "studio_tracks", "studio_releases", "content_moderation"
       CASCADE`,
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('records one kept track per source track and one link per purchase before the re-key', async () => {
    const outcome = await forgetSales();

    expect(outcome.keptTrackCount).toBe(2);
    const keptRows = await keptTrackRows();
    // The withheld track and the one with no audio are kept for nobody.
    expect(
      keptRows.map((row) => [
        row.title,
        row.duration_seconds,
        row.audio_content_type,
        row.source_audio_key,
        row.audio_key,
        row.copy_attempts,
      ]),
    ).toEqual([['Harbour', 200, 'audio/mpeg', PLAYABLE_AUDIO_KEY, null, 0]]);
    const keptTrackIds = keptRows.map((row) => row.id);
    expect(
      (await keptLinkRows()).map((row) => [
        row.purchase_id,
        keptTrackIds.includes(row.kept_track_id),
        row.position,
      ]),
    ).toEqual([
      [ALBUM_PURCHASE, true, 1],
      [TRACK_PURCHASE, true, 1],
    ]);
  });

  it('expires the pending claim and answers its id', async () => {
    const outcome = await forgetSales();

    expect(outcome.expiredPurchaseIds).toEqual([PENDING_PURCHASE]);
    const rows = await purchaseRows();
    expect(
      rows.map((row) => [row.id, row.status, row.decided_at !== null]),
    ).toEqual([
      [ALBUM_PURCHASE, 'confirmed', true],
      [TRACK_PURCHASE, 'confirmed', true],
      [PENDING_PURCHASE, 'expired', true],
      [DECLINED_PURCHASE, 'declined', true],
      [WALL_PURCHASE, 'confirmed', true],
      [OTHER_PENDING_PURCHASE, 'pending', false],
    ]);
    // A row already decided keeps its decision time.
    expect((await purchaseRow(DECLINED_PURCHASE))?.decided_at).toEqual(
      new Date(DECLINED_AT),
    );
  });

  it('deletes the payment methods and takes every release and track off sale', async () => {
    await forgetSales();

    expect(await paymentMethodPersonaIds()).toEqual([OTHER_PERSONA]);
    expect(
      (await releasePriceRows()).map((row) => [
        row.id,
        row.price_mode,
        row.price_cents,
      ]),
    ).toEqual([
      [ALBUM_RELEASE, 'not_for_sale', null],
      [SINGLE_RELEASE, 'not_for_sale', null],
      [OTHER_RELEASE, 'fixed', 500],
    ]);
    expect(
      (await trackPriceRows()).map((row) => [
        row.id,
        row.price_mode,
        row.price_cents,
      ]),
    ).toEqual([
      [PLAYABLE_TRACK, 'not_for_sale', null],
      [WITHHELD_TRACK, 'not_for_sale', null],
      [SILENT_TRACK, 'not_for_sale', null],
      [SINGLE_TRACK, 'not_for_sale', null],
      [OTHER_TRACK, 'fixed', 200],
    ]);
  });

  it('keeps kept rows and links after the re-key nulls the purchase ids', async () => {
    await forgetSales();
    const keptBefore = await keptTrackRows();
    const linksBefore = await keptLinkRows();

    // The release and track re-key of `issueFreshPersonaId`, reduced to the
    // id moves the purchase keys react to.
    await dataSource.query(
      `UPDATE "studio_releases" SET "id" = gen_random_uuid() WHERE "subprofile_id" = $1`,
      [MUSIC_PERSONA],
    );
    await dataSource.query(
      `UPDATE "studio_tracks" SET "id" = gen_random_uuid()
        WHERE "release_id" IN (
          SELECT "id" FROM "studio_releases" WHERE "subprofile_id" = $1
        )`,
      [MUSIC_PERSONA],
    );

    const rows = await purchaseRows();
    expect(
      rows
        .filter((row) => row.artist_name === 'Harbour Lights')
        .map((row) => [
          row.id,
          row.subprofile_id,
          row.release_id,
          row.track_id,
          row.item_title,
        ]),
    ).toEqual([
      [ALBUM_PURCHASE, null, null, null, 'Low tide'],
      [TRACK_PURCHASE, null, null, null, 'Harbour'],
      [PENDING_PURCHASE, null, null, null, 'Low tide'],
      [DECLINED_PURCHASE, null, null, null, 'Low tide'],
    ]);
    expect(await keptTrackRows()).toEqual(keptBefore);
    expect(await keptLinkRows()).toEqual(linksBefore);
  });

  it('clears a wall choice of the persona and keeps the flag', async () => {
    await forgetSales();

    const row = await purchaseRow(WALL_PURCHASE);
    expect([
      row?.is_on_wall,
      row?.is_shown_as_persona,
      row?.shown_as_subprofile_id,
      row?.subprofile_id,
    ]).toEqual([true, true, null, OTHER_PERSONA]);
  });

  it('leaves purchases of other personas alone', async () => {
    await forgetSales();

    const rows = await purchaseRows();
    expect(
      rows
        .filter((row) => row.artist_name === 'Tram 28')
        .map((row) => [
          row.id,
          row.subprofile_id,
          row.release_id,
          row.track_id,
          row.status,
        ]),
    ).toEqual([
      [WALL_PURCHASE, OTHER_PERSONA, OTHER_RELEASE, null, 'confirmed'],
      [OTHER_PENDING_PURCHASE, OTHER_PERSONA, null, OTHER_TRACK, 'pending'],
    ]);
    expect(
      (await keptLinkRows()).map((link) => link.purchase_id),
    ).not.toContain(WALL_PURCHASE);
  });

  // Contract 3.7 step 6: a persona under a moderator takedown answers no
  // download, so its unlink keeps no files.
  it('keeps no files for the buyers of a persona under a moderator takedown', async () => {
    await dataSource.query(
      `INSERT INTO "content_moderation" ("subject_type", "subject_id", "hidden_at")
       VALUES ('subprofile', $1, now())`,
      [MUSIC_PERSONA],
    );

    const outcome = await forgetSales();

    expect(outcome).toEqual({
      expiredPurchaseIds: [PENDING_PURCHASE],
      keptTrackCount: 0,
    });
    expect(await keptTrackRows()).toEqual([]);
    expect(await keptLinkRows()).toEqual([]);
  });
});

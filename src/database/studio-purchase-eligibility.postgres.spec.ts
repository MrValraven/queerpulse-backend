// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  RELEASE_FOR_VIEWER_SQL,
  TRACK_FOR_VIEWER_SQL,
} from '../studio/studio-purchase-rows';
import {
  studioOfferState,
  uniqueViolationConstraint,
} from '../studio/studio-purchase-rules';
import {
  OFFER_FACTS_SQL,
  PURCHASE_INSERT_SQL,
} from '../studio/studio-purchases.service';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Purchase eligibility (contract 3.1, 3.2 and 4.5) on real Postgres: the
 * offer facts, the release readability read and the purchase insert, run
 * directly. Skipped unless `STUDIO_MIGRATIONS_DATABASE_URL` names a database
 * whose name ends in `_test` (it drops and synchronizes the schema from the
 * entities). Each test inserts its own purchases and deletes them afterwards.
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

// The creator has no `subprofile_members` row; the co-owner has one.
const ARTIST_CREATOR = 'e1000000-0000-4000-8000-000000000001';
const CO_OWNER = 'e1000000-0000-4000-8000-000000000002';
const BUYER_A = 'e1000000-0000-4000-8000-000000000003';
// The co-owner blocks B.
const BUYER_B = 'e1000000-0000-4000-8000-000000000004';

const MUSIC_PERSONA = 'e2000000-0000-4000-8000-000000000001';

const ALBUM_ID = 'e4000000-0000-4000-8000-000000000001';
const DRAFT_SINGLE_ID = 'e4000000-0000-4000-8000-000000000002';
const TRACK_ID = 'e5000000-0000-4000-8000-000000000001';
const WITHHELD_TRACK_ID = 'e5000000-0000-4000-8000-000000000002';

const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

interface ReleaseForViewerRow {
  release_id: string;
  release_type: string;
  release_status: string;
  price_mode: string;
  price_cents: number | null;
  is_member: boolean;
}

interface TrackForViewerRow extends ReleaseForViewerRow {
  track_id: string;
  is_track_withheld: boolean;
  has_playable_audio: boolean;
}

interface OfferFactsRow {
  is_owned: boolean;
  owned_purchase_id: string | null;
  pending_purchase_id: string | null;
  is_blocked: boolean;
  payment_method_count: number;
}

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio purchase eligibility on real Postgres', () => {
  let dataSource: DataSource;
  let referenceCounter = 0;

  /** A valid reference code that no other row of this run holds. */
  const nextReferenceCode = (): string => {
    referenceCounter += 1;
    const first = REFERENCE_ALPHABET[Math.floor(referenceCounter / 31) % 31];
    const second = REFERENCE_ALPHABET[referenceCounter % 31];
    return `EL${first}${second}ZZ`;
  };

  const releaseForViewer = (
    releaseId: string,
    viewerId: string,
  ): Promise<ReleaseForViewerRow[]> =>
    dataSource.query(RELEASE_FOR_VIEWER_SQL, [releaseId, viewerId]);

  const trackForViewer = (
    trackId: string,
    viewerId: string,
  ): Promise<TrackForViewerRow[]> =>
    dataSource.query(TRACK_FOR_VIEWER_SQL, [trackId, viewerId]);

  const offerFacts = async (
    trackId: string | null,
    callerId: string,
  ): Promise<OfferFactsRow> => {
    const rows: OfferFactsRow[] = await dataSource.query(OFFER_FACTS_SQL, [
      ALBUM_ID,
      trackId,
      callerId,
    ]);
    const [facts] = rows;
    if (!facts) {
      throw new Error('The offer facts read came back empty');
    }
    return facts;
  };

  /** The facts of `offerFacts` as [is_owned, owned, pending]. */
  const ownershipOf = async (
    trackId: string | null,
    callerId: string,
  ): Promise<[boolean, string | null, string | null]> => {
    const facts = await offerFacts(trackId, callerId);
    return [facts.is_owned, facts.owned_purchase_id, facts.pending_purchase_id];
  };

  /** A pending claim through the service's own insert; returns its id. */
  const claim = async (
    buyerId: string,
    item: { releaseId: string } | { trackId: string },
  ): Promise<string> => {
    const isTrack = 'trackId' in item;
    const rows: { id: string }[] = await dataSource.query(PURCHASE_INSERT_SQL, [
      buyerId,
      MUSIC_PERSONA,
      'Harbour Lights',
      isTrack ? 'track' : 'release',
      isTrack ? null : item.releaseId,
      isTrack ? item.trackId : null,
      'Low tide',
      700,
      nextReferenceCode(),
      null,
      false,
      false,
      null,
    ]);
    const [inserted] = rows;
    if (!inserted) {
      throw new Error('The purchase insert returned no row');
    }
    return inserted.id;
  };

  const decide = async (
    purchaseId: string,
    status: 'confirmed' | 'declined',
  ): Promise<void> => {
    await dataSource.query(
      `UPDATE "studio_purchases"
          SET "status" = $2::text::studio_purchase_status,
              "decline_reason" = CASE WHEN $2::text = 'declined'
                                      THEN 'payment_not_found'::studio_purchase_decline_reason
                                      END,
              "decided_at" = now()
        WHERE "id" = $1::uuid`,
      [purchaseId, status],
    );
  };

  const withPurchases = async (check: () => Promise<void>): Promise<void> => {
    try {
      await check();
    } finally {
      await dataSource.query(`DELETE FROM "studio_purchases"`);
    }
  };

  /** The viewer state of the album offer, from the two reads the service
   *  makes. */
  const albumOfferState = async (
    callerId: string,
  ): Promise<ReturnType<typeof studioOfferState>> => {
    const [release] = await releaseForViewer(ALBUM_ID, callerId);
    if (!release) {
      throw new Error('The album is unreadable for this caller');
    }
    const facts = await offerFacts(null, callerId);
    return studioOfferState({
      isPersonaMember: release.is_member,
      priceMode: release.price_mode,
      releaseType: release.release_type,
      isOwned: facts.is_owned,
      hasPendingClaim: facts.pending_purchase_id !== null,
      releaseStatus: release.release_status,
      isTrackOffer: false,
      isTrackWithheld: false,
      hasPlayableAudio: true,
      isBlocked: facts.is_blocked,
      hasPaymentMethods: facts.payment_method_count > 0,
    });
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

    await dataSource.getRepository(User).insert(
      [ARTIST_CREATOR, CO_OWNER, BUYER_A, BUYER_B].map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.getRepository(Subprofile).insert({
      id: MUSIC_PERSONA,
      userId: ARTIST_CREATOR,
      slug: 'harbour-lights',
      handle: 'harbour-lights',
      displayName: 'Harbour Lights',
      kind: SubprofileKind.Musician,
      status: SubprofileStatus.Published,
      visibility: SubprofileVisibility.Open,
    });
    await dataSource
      .getRepository(SubprofileMember)
      .insert([{ subprofileId: MUSIC_PERSONA, userId: CO_OWNER }]);
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at", "price_mode", "price_cents")
       VALUES ($1, $3, 'Low tide', 'album', 'published', now(), 'fixed', 700),
              ($2, $3, 'Night bus', 'single', 'draft', NULL, 'fixed', 300)`,
      [ALBUM_ID, DRAFT_SINGLE_ID, MUSIC_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "audio_content_type", "duration_seconds", "price_mode", "price_cents", "withheld_at")
       VALUES ($1, $3, 1, 'Harbour', 'studio-audio/a/b.mp3', 'audio/mpeg', 200, 'fixed', 150, NULL),
              ($2, $3, 2, 'Lights', 'studio-audio/a/c.mp3', 'audio/mpeg', 200, 'name_your_price', 0, now())`,
      [TRACK_ID, WITHHELD_TRACK_ID, ALBUM_ID],
    );
    await dataSource.query(
      `INSERT INTO "studio_payment_methods" ("subprofile_id", "kind", "label", "value", "note", "position")
       VALUES ($1, 'link', NULL, 'https://pay.example/harbour-lights', NULL, 0)`,
      [MUSIC_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "blocks" ("blocker_id", "blocked_id") VALUES ($1, $2)`,
      [CO_OWNER, BUYER_B],
    );
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('refuses the persona creator who has no member row', async () => {
    const creatorMemberRows: unknown[] = await dataSource.query(
      `SELECT 1 FROM "subprofile_members" WHERE "subprofile_id" = $1 AND "user_id" = $2`,
      [MUSIC_PERSONA, ARTIST_CREATOR],
    );
    expect(creatorMemberRows).toEqual([]);
    expect(
      (await releaseForViewer(ALBUM_ID, ARTIST_CREATOR)).map(
        (row) => row.is_member,
      ),
    ).toEqual([true]);
    expect(
      (await releaseForViewer(ALBUM_ID, BUYER_A)).map((row) => row.is_member),
    ).toEqual([false]);
    expect(await albumOfferState(ARTIST_CREATOR)).toEqual({
      state: 'refused',
      refusalCode: 'studio_purchase_own_persona',
    });
    expect(await albumOfferState(BUYER_A)).toEqual({
      state: 'can_buy',
      refusalCode: null,
    });
  });

  it('owns a track through its release and stays free to buy the release while owning a track', async () => {
    await withPurchases(async () => {
      const trackPurchaseId = await claim(BUYER_A, { trackId: TRACK_ID });
      await decide(trackPurchaseId, 'confirmed');
      expect(await ownershipOf(TRACK_ID, BUYER_A)).toEqual([
        true,
        trackPurchaseId,
        null,
      ]);
      // Owning a track leaves the release to buy.
      expect(await ownershipOf(null, BUYER_A)).toEqual([false, null, null]);

      const releasePurchaseId = await claim(BUYER_A, { releaseId: ALBUM_ID });
      expect(await ownershipOf(null, BUYER_A)).toEqual([
        false,
        null,
        releasePurchaseId,
      ]);
      await decide(releasePurchaseId, 'confirmed');
      expect(await ownershipOf(null, BUYER_A)).toEqual([
        true,
        releasePurchaseId,
        null,
      ]);
      // The release covers every track; a track's own purchase comes first.
      expect(await ownershipOf(WITHHELD_TRACK_ID, BUYER_A)).toEqual([
        true,
        releasePurchaseId,
        null,
      ]);
      expect(await ownershipOf(TRACK_ID, BUYER_A)).toEqual([
        true,
        trackPurchaseId,
        null,
      ]);
      // Another buyer owns nothing.
      expect(await ownershipOf(TRACK_ID, BUYER_B)).toEqual([false, null, null]);
    });
  });

  it('keeps a track buyable while its release has a pending claim', async () => {
    await withPurchases(async () => {
      const releaseClaimId = await claim(BUYER_A, { releaseId: ALBUM_ID });
      expect(await ownershipOf(null, BUYER_A)).toEqual([
        false,
        null,
        releaseClaimId,
      ]);
      expect(await ownershipOf(TRACK_ID, BUYER_A)).toEqual([false, null, null]);

      const trackClaimId = await claim(BUYER_A, { trackId: TRACK_ID });
      expect(await ownershipOf(TRACK_ID, BUYER_A)).toEqual([
        false,
        null,
        trackClaimId,
      ]);
      expect(await ownershipOf(null, BUYER_A)).toEqual([
        false,
        null,
        releaseClaimId,
      ]);

      // The withheld track reads as unavailable; the other one plays.
      expect(
        (await trackForViewer(TRACK_ID, BUYER_A)).map((row) => [
          row.is_track_withheld,
          row.has_playable_audio,
        ]),
      ).toEqual([[false, true]]);
      expect(
        (await trackForViewer(WITHHELD_TRACK_ID, BUYER_A)).map(
          (row) => row.is_track_withheld,
        ),
      ).toEqual([true]);
    });
  });

  it('refuses a buyer blocked either way by a co-owner with the neutral code', async () => {
    // The block names the co-owner, so the release still reads for B and the
    // refusal is the neutral one.
    expect(await releaseForViewer(ALBUM_ID, BUYER_B)).toHaveLength(1);
    expect((await offerFacts(null, BUYER_B)).is_blocked).toBe(true);
    expect((await offerFacts(TRACK_ID, BUYER_B)).is_blocked).toBe(true);
    expect((await offerFacts(null, BUYER_A)).is_blocked).toBe(false);
    expect(await albumOfferState(BUYER_B)).toEqual({
      state: 'refused',
      refusalCode: 'studio_purchase_unavailable',
    });

    await dataSource.query(
      `INSERT INTO "blocks" ("blocker_id", "blocked_id") VALUES ($1, $2)`,
      [BUYER_A, CO_OWNER],
    );
    try {
      expect((await offerFacts(null, BUYER_A)).is_blocked).toBe(true);
      expect(await albumOfferState(BUYER_A)).toEqual({
        state: 'refused',
        refusalCode: 'studio_purchase_unavailable',
      });
    } finally {
      await dataSource.query(
        `DELETE FROM "blocks" WHERE "blocker_id" = $1 AND "blocked_id" = $2`,
        [BUYER_A, CO_OWNER],
      );
    }
  });

  it('opens a draft release to its members only', async () => {
    expect(
      (await releaseForViewer(DRAFT_SINGLE_ID, CO_OWNER)).map((row) => [
        row.release_id,
        row.release_status,
        row.is_member,
      ]),
    ).toEqual([[DRAFT_SINGLE_ID, 'draft', true]]);
    expect(
      (await releaseForViewer(DRAFT_SINGLE_ID, ARTIST_CREATOR)).map(
        (row) => row.is_member,
      ),
    ).toEqual([true]);
    expect(await releaseForViewer(DRAFT_SINGLE_ID, BUYER_A)).toEqual([]);
  });

  it('lets the partial unique index refuse the second pending claim with 23505', async () => {
    await withPurchases(async () => {
      await claim(BUYER_A, { releaseId: ALBUM_ID });
      const caught: unknown = await claim(BUYER_A, {
        releaseId: ALBUM_ID,
      }).catch((error: unknown) => error);
      expect(uniqueViolationConstraint(caught)).toBe(
        'UQ_studio_purchases_pending_release',
      );

      await claim(BUYER_A, { trackId: TRACK_ID });
      const caughtTrack: unknown = await claim(BUYER_A, {
        trackId: TRACK_ID,
      }).catch((error: unknown) => error);
      expect(uniqueViolationConstraint(caughtTrack)).toBe(
        'UQ_studio_purchases_pending_track',
      );

      const pendingRows: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "studio_purchases" WHERE "status" = 'pending'`,
      );
      expect(pendingRows.map((row) => row.count)).toEqual([2]);
    });
  });

  it('frees the claim slot after a decline', async () => {
    await withPurchases(async () => {
      const declinedId = await claim(BUYER_A, { releaseId: ALBUM_ID });
      await decide(declinedId, 'declined');
      expect(await ownershipOf(null, BUYER_A)).toEqual([false, null, null]);

      const secondClaimId = await claim(BUYER_A, { releaseId: ALBUM_ID });
      expect(secondClaimId).not.toBe(declinedId);
      expect(await ownershipOf(null, BUYER_A)).toEqual([
        false,
        null,
        secondClaimId,
      ]);
    });
  });
});

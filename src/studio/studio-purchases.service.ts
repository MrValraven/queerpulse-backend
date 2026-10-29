import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { isForeignKeyViolation } from '../common/db-errors';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import { Profile } from '../users/entities/profile.entity';
import { CreateStudioPurchaseDto } from './dto/create-studio-purchase.dto';
import { UpdateStudioPurchaseWallDto } from './dto/update-studio-purchase-wall.dto';
import {
  StudioPurchaseItemKind,
  StudioPurchaseStatus,
} from './entities/studio-purchase.entity';
import { StudioBuyerPurchasesService } from './studio-buyer-purchases.service';
import {
  artistRefFromColumns,
  personaColumnsFromRow,
} from './studio-discovery-sql';
import { PERSONA_PAYMENT_METHODS_SQL } from './studio-payment-methods.service';
import { blockedWithAnyPersonaMemberSql } from './studio-persona-members';
import {
  STUDIO_PURCHASE_CLAIMED,
  StudioPurchaseEvent,
} from './studio-purchase.events';
import {
  deriveStudioPurchaseReferenceKey,
  issueStudioPurchaseReference,
  isStudioPurchaseReferenceValid,
} from './studio-purchase-reference';
import {
  RELEASE_FOR_VIEWER_SQL,
  TRACK_FOR_VIEWER_SQL,
} from './studio-purchase-rows';
import {
  StudioOfferFacts,
  studioAmountRefusal,
  studioArtistNameSnapshot,
  studioCreateRefusal,
  studioItemTitleSnapshot,
  studioOfferState,
  toStudioPrice,
  uniqueViolationConstraint,
} from './studio-purchase-rules';
import {
  StudioBuyerPurchase,
  StudioOffer,
  StudioPaymentMethodResponse,
  StudioPurchaseReference,
  StudioPurchaseWallState,
  StudioTrackOffer,
} from './studio-purchases-response';
import {
  StudioSupporterOption,
  SupporterPersonaRow,
  toStudioSupporterIdentity,
} from './studio-supporters';
import { MEMBER_PERSONAS_SQL } from './studio-supporters.service';
import { studioError, studioErrorWithDetails } from './studio.constants';

/** Stands in for a gone artist persona in `MEMBER_PERSONAS_SQL`, whose
 *  `"persona"."id" <> $2::uuid` reads a null as unknown and keeps no row. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The caller's newest purchase of one status matching `itemConditionSql`,
 * which reads the `"caller_purchase"` alias. A track's own purchase comes
 * before its release's.
 */
function callerPurchaseIdSql(
  callerExpression: string,
  status: StudioPurchaseStatus,
  itemConditionSql: string,
): string {
  return `(SELECT "caller_purchase"."id"
     FROM "studio_purchases" "caller_purchase"
    WHERE "caller_purchase"."buyer_user_id" = ${callerExpression}
      AND "caller_purchase"."status" = '${status}'
      AND ${itemConditionSql}
    ORDER BY ("caller_purchase"."track_id" IS NOT NULL) DESC,
             "caller_purchase"."created_at" DESC,
             "caller_purchase"."id" DESC
    LIMIT 1)`;
}

/**
 * Contract 3.1 and 4.5. `$1` the release (a track offer passes the track's
 * release), `$2` the track or null for the release offer, `$3` the caller.
 * One row, or none for an unknown release. `owned_purchase_id` is the
 * confirmed purchase that covers the item (the track's own, or its
 * release's; a release offer counts release purchases only), `is_owned` is
 * true when it exists, `pending_purchase_id` is the caller's pending
 * purchase of this exact item, `is_blocked` a block either way with any
 * persona member, `payment_method_count` the persona's methods.
 */
export const OFFER_FACTS_SQL = `SELECT "facts".*,
       ("facts"."owned_purchase_id" IS NOT NULL) AS "is_owned"
  FROM (
    SELECT ${callerPurchaseIdSql(
      '$3::uuid',
      StudioPurchaseStatus.Confirmed,
      `("caller_purchase"."release_id" = "release"."id" OR "caller_purchase"."track_id" = $2::uuid)`,
    )} AS "owned_purchase_id",
           ${callerPurchaseIdSql(
             '$3::uuid',
             StudioPurchaseStatus.Pending,
             `(($2::uuid IS NULL AND "caller_purchase"."release_id" = "release"."id") OR "caller_purchase"."track_id" = $2::uuid)`,
           )} AS "pending_purchase_id",
           ${blockedWithAnyPersonaMemberSql('$3::uuid', '"release"."subprofile_id"')} AS "is_blocked",
           (SELECT COUNT(*)::int
              FROM "studio_payment_methods" "method"
             WHERE "method"."subprofile_id" = "release"."subprofile_id") AS "payment_method_count"
      FROM "studio_releases" "release"
     WHERE "release"."id" = $1::uuid
  ) "facts"`;

/**
 * Contract 3.1 `trackOffers`. `$1` the release, `$2` the caller. Every
 * priced track of the release, `position ASC, id ASC`, with the per-track
 * facts of `OFFER_FACTS_SQL` (`is_owned`, `owned_purchase_id`,
 * `pending_purchase_id`) and the track facts of `TRACK_FOR_VIEWER_SQL`. The
 * persona facts (block, payment methods) are the release's.
 */
export const RELEASE_TRACK_OFFERS_SQL = `SELECT "facts".*,
       ("facts"."owned_purchase_id" IS NOT NULL) AS "is_owned"
  FROM (
    SELECT "track"."id" AS "track_id",
           "track"."position" AS "track_position",
           "track"."title" AS "track_title",
           "track"."price_mode"::text AS "price_mode",
           "track"."price_cents" AS "price_cents",
           ("track"."withheld_at" IS NOT NULL) AS "is_track_withheld",
           ("track"."audio_key" IS NOT NULL AND "track"."audio_content_type" IS NOT NULL) AS "has_playable_audio",
           ${callerPurchaseIdSql(
             '$2::uuid',
             StudioPurchaseStatus.Confirmed,
             `("caller_purchase"."track_id" = "track"."id" OR "caller_purchase"."release_id" = "track"."release_id")`,
           )} AS "owned_purchase_id",
           ${callerPurchaseIdSql(
             '$2::uuid',
             StudioPurchaseStatus.Pending,
             `"caller_purchase"."track_id" = "track"."id"`,
           )} AS "pending_purchase_id"
      FROM "studio_tracks" "track"
     WHERE "track"."release_id" = $1::uuid
       AND "track"."price_mode"::text <> 'not_for_sale'
  ) "facts"
 ORDER BY "facts"."track_position" ASC, "facts"."track_id" ASC`;

/**
 * Contract 3.2 step 7. `$1` buyer, `$2` artist persona, `$3` artist name
 * snapshot, `$4` item kind, `$5` release or null, `$6` track or null, `$7`
 * item title snapshot, `$8` amount in cents, `$9` the verified reference
 * code, `$10` payer name or null, `$11` is on wall, `$12` is shown as
 * persona, `$13` the persona shown or null. Returns the new id.
 */
export const PURCHASE_INSERT_SQL = `INSERT INTO "studio_purchases"
  ("buyer_user_id", "subprofile_id", "artist_name", "item_kind", "release_id",
   "track_id", "item_title", "amount_cents", "reference_code", "payer_name",
   "is_on_wall", "is_shown_as_persona", "shown_as_subprofile_id")
VALUES ($1::uuid, $2::uuid, $3, $4::studio_purchase_item_kind, $5::uuid,
        $6::uuid, $7, $8::integer, $9, $10,
        $11::boolean, $12::boolean, $13::uuid)
RETURNING "id"`;

/** `$1` the purchase. The columns the buyer's cancel and wall routes read. */
export const OWN_PURCHASE_SQL = `SELECT "purchase"."id",
       "purchase"."buyer_user_id",
       "purchase"."subprofile_id",
       "purchase"."status"::text AS "status",
       "purchase"."is_on_wall",
       "purchase"."is_shown_as_persona",
       "purchase"."shown_as_subprofile_id"
  FROM "studio_purchases" "purchase"
 WHERE "purchase"."id" = $1::uuid`;

/**
 * Contract 3.3, 3.4 and 4.2: the purchase row lock every write out of
 * `pending` and every wall write takes first, the row lock the sales
 * service takes. The buyer check runs on the locked row.
 */
export const LOCK_OWN_PURCHASE_SQL = `${OWN_PURCHASE_SQL}
   FOR UPDATE`;

/** `$1` the purchase. */
export const PURCHASE_CANCEL_SQL = `UPDATE "studio_purchases"
   SET "status" = 'cancelled', "decided_at" = now(), "updated_at" = now()
 WHERE "id" = $1::uuid`;

/** `$1` the purchase, `$2` is shown as persona, `$3` the persona or null. */
export const PURCHASE_WALL_ON_SQL = `UPDATE "studio_purchases"
   SET "is_on_wall" = true,
       "is_shown_as_persona" = $2::boolean,
       "shown_as_subprofile_id" = $3::uuid,
       "updated_at" = now()
 WHERE "id" = $1::uuid`;

/** `$1` the purchase. The identity columns keep the buyer's choice. */
export const PURCHASE_WALL_OFF_SQL = `UPDATE "studio_purchases"
   SET "is_on_wall" = false, "updated_at" = now()
 WHERE "id" = $1::uuid`;

/** Persona unique indexes that answer `studio_purchase_pending_exists`. */
const PENDING_CLAIM_CONSTRAINTS = new Set([
  'UQ_studio_purchases_pending_release',
  'UQ_studio_purchases_pending_track',
]);

const REFERENCE_CODE_CONSTRAINT = 'UQ_studio_purchases_reference_code';

/**
 * Foreign keys whose violation means the item went away between the offer
 * read and the insert (persona, release or track deleted): the purchase
 * answers `studio_purchase_item_not_found`.
 */
export const PURCHASE_ITEM_FOREIGN_KEYS = [
  'FK_studio_purchases_subprofile',
  'FK_studio_purchases_release',
  'FK_studio_purchases_track',
] as const;

type Queryable = Pick<EntityManager, 'query'>;

/** One `RELEASE_FOR_VIEWER_SQL` row, plus the track columns of
 *  `TRACK_FOR_VIEWER_SQL` on a track offer. */
type ItemForViewerRow = {
  release_id: string;
  release_title: string;
  release_type: string;
  release_status: string;
  release_cover_key: string | null;
  artist_id: string;
  artist_handle: string | null;
  artist_display_name: string;
  artist_kind: string;
  artist_avatar_url: string | null;
  price_mode: string;
  price_cents: number | null;
  is_member: boolean;
  track_id?: string;
  track_title?: string;
  is_track_withheld?: boolean;
  has_playable_audio?: boolean;
};

interface OfferFactsRow {
  is_owned: boolean;
  owned_purchase_id: string | null;
  pending_purchase_id: string | null;
  is_blocked: boolean;
  payment_method_count: number;
}

interface TrackOfferRow {
  track_id: string;
  track_position: number;
  track_title: string;
  price_mode: string;
  price_cents: number | null;
  is_track_withheld: boolean;
  has_playable_audio: boolean;
  is_owned: boolean;
  owned_purchase_id: string | null;
  pending_purchase_id: string | null;
}

interface PaymentMethodRow {
  id: string;
  kind: StudioPaymentMethodResponse['kind'];
  label: string | null;
  value: string;
  note: string | null;
  position: number;
}

interface OwnPurchaseRow {
  id: string;
  buyer_user_id: string | null;
  subprofile_id: string | null;
  status: StudioPurchaseStatus;
  is_on_wall: boolean;
  is_shown_as_persona: boolean;
  shown_as_subprofile_id: string | null;
}

/** The item an offer or a create is about, read for the caller. */
interface ItemForViewer {
  row: ItemForViewerRow;
  trackId: string | null;
}

function toPaymentMethod(row: PaymentMethodRow): StudioPaymentMethodResponse {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    value: row.value,
    note: row.note,
    position: Number(row.position),
  };
}

function offerFactsOf(
  item: ItemForViewer,
  facts: OfferFactsRow,
): StudioOfferFacts {
  const isTrackOffer = item.trackId !== null;
  return {
    isPersonaMember: item.row.is_member,
    priceMode: item.row.price_mode,
    releaseType: item.row.release_type,
    isOwned: facts.is_owned,
    hasPendingClaim: facts.pending_purchase_id !== null,
    releaseStatus: item.row.release_status,
    isTrackOffer,
    isTrackWithheld: isTrackOffer && item.row.is_track_withheld === true,
    hasPlayableAudio: !isTrackOffer || item.row.has_playable_audio === true,
    isBlocked: facts.is_blocked,
    hasPaymentMethods: Number(facts.payment_method_count) > 0,
  };
}

/**
 * Studio purchases for the buyer, contract sections 3.1 to 3.4. The offer
 * routes read only: nothing is recorded until "I've paid" creates the
 * purchase, and no offer read is counted or logged. The reference code
 * route (4.4) signs a code for the caller and stores and logs nothing.
 * Creation runs the contract 3.2 checks in order and takes no row lock: the
 * partial unique indexes decide a race between two taps. Cancel and the
 * wall write take the purchase row lock inside their transaction before
 * any check.
 */
@Injectable()
export class StudioPurchasesService {
  private readonly referenceKey: Buffer;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly buyerPurchases: StudioBuyerPurchasesService,
    private readonly eventEmitter: EventEmitter2,
    config: ConfigService,
  ) {
    this.referenceKey = deriveStudioPurchaseReferenceKey(
      config.get<string>('auth.jwtAccessSecret'),
      config.get<string>('app.nodeEnv'),
    );
  }

  /** Route 18: a fresh code and its signed token. Stores and logs nothing. */
  issueReference(userId: string): StudioPurchaseReference {
    return issueStudioPurchaseReference(this.referenceKey, userId);
  }

  async releaseOffer(userId: string, releaseId: string): Promise<StudioOffer> {
    const item = await this.readItem(userId, releaseId, null);
    return this.offerFor(userId, item);
  }

  async trackOffer(userId: string, trackId: string): Promise<StudioOffer> {
    const item = await this.readItem(userId, null, trackId);
    return this.offerFor(userId, item);
  }

  /** Contract 3.2, steps 1 to 8 in order. */
  async create(
    userId: string,
    body: CreateStudioPurchaseDto,
  ): Promise<StudioBuyerPurchase> {
    const releaseId = body.releaseId ?? null;
    const trackId = body.trackId ?? null;
    if ((releaseId === null) === (trackId === null)) {
      throw studioError('studio_purchase_item_required');
    }
    const item = await this.readItem(userId, releaseId, trackId);
    const facts = offerFactsOf(item, await this.readFacts(userId, item));
    const refusalCode = studioCreateRefusal(facts);
    if (refusalCode) {
      throw studioError(refusalCode);
    }
    if (
      !isStudioPurchaseReferenceValid(
        this.referenceKey,
        userId,
        body.referenceCode,
        body.referenceToken,
      )
    ) {
      throw studioError('studio_purchase_reference_invalid');
    }
    const price = toStudioPrice(item.row.price_mode, item.row.price_cents);
    if (price === null) {
      throw studioError('studio_purchase_not_for_sale');
    }
    const amountRefusal = studioAmountRefusal(price, body.amountCents);
    if (amountRefusal === 'studio_purchase_price_changed') {
      throw studioErrorWithDetails(amountRefusal, { price });
    }
    if (amountRefusal) {
      throw studioError(amountRefusal);
    }
    const personaId = item.row.artist_id;
    const shownAsSubprofileId = body.isOnWall ? body.shownAsSubprofileId : null;
    if (shownAsSubprofileId !== null) {
      const personaRows: SupporterPersonaRow[] = await this.dataSource.query(
        MEMBER_PERSONAS_SQL,
        [userId, personaId, shownAsSubprofileId],
      );
      if (!personaRows.length) {
        throw studioError('studio_supporter_identity_not_yours');
      }
    }
    const purchaseId = await this.insertPurchase([
      userId,
      personaId,
      studioArtistNameSnapshot(
        item.row.artist_display_name,
        item.row.artist_handle,
      ),
      item.trackId === null
        ? StudioPurchaseItemKind.Release
        : StudioPurchaseItemKind.Track,
      item.trackId === null ? item.row.release_id : null,
      item.trackId,
      studioItemTitleSnapshot(item.row.track_title ?? item.row.release_title),
      body.amountCents,
      body.referenceCode,
      toStoredPlainTextOrNull(body.payerName),
      body.isOnWall,
      shownAsSubprofileId !== null,
      shownAsSubprofileId,
    ]);
    const claimedEvent: StudioPurchaseEvent = { purchaseId };
    this.eventEmitter.emit(STUDIO_PURCHASE_CLAIMED, claimedEvent);
    const [purchase] = await this.buyerPurchases.readByIds(userId, [
      purchaseId,
    ]);
    if (!purchase) {
      throw studioError('studio_purchase_not_found');
    }
    return purchase;
  }

  /** Contract 3.3. */
  async cancel(userId: string, purchaseId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const purchase = await this.lockOwnPurchase(manager, userId, purchaseId);
      if (purchase.status !== StudioPurchaseStatus.Pending) {
        throw studioError('studio_purchase_not_pending');
      }
      await manager.query(PURCHASE_CANCEL_SQL, [purchase.id]);
    });
  }

  /** Contract 3.4, GET. */
  async getWall(
    userId: string,
    purchaseId: string,
  ): Promise<StudioPurchaseWallState> {
    const rows: OwnPurchaseRow[] = await this.dataSource.query(
      OWN_PURCHASE_SQL,
      [purchaseId],
    );
    const purchase = rows[0];
    if (!purchase || purchase.buyer_user_id !== userId) {
      throw studioError('studio_purchase_not_found');
    }
    return this.wallStateOf(this.dataSource, userId, purchase);
  }

  /** Contract 3.4, PUT. Turning the wall off keeps the identity choice. */
  async updateWall(
    userId: string,
    purchaseId: string,
    body: UpdateStudioPurchaseWallDto,
  ): Promise<StudioPurchaseWallState> {
    return this.dataSource.transaction(async (manager) => {
      const purchase = await this.lockOwnPurchase(manager, userId, purchaseId);
      const isWallOpen =
        purchase.status === StudioPurchaseStatus.Pending ||
        purchase.status === StudioPurchaseStatus.Confirmed;
      if (!isWallOpen || purchase.subprofile_id === null) {
        throw studioError('studio_purchase_wall_not_available');
      }
      if (!body.isOnWall) {
        await manager.query(PURCHASE_WALL_OFF_SQL, [purchase.id]);
        return this.wallStateOf(manager, userId, {
          ...purchase,
          is_on_wall: false,
        });
      }
      const shownAsSubprofileId = body.shownAsSubprofileId;
      if (shownAsSubprofileId !== null) {
        const personaRows: SupporterPersonaRow[] = await manager.query(
          MEMBER_PERSONAS_SQL,
          [userId, purchase.subprofile_id, shownAsSubprofileId],
        );
        if (!personaRows.length) {
          throw studioError('studio_supporter_identity_not_yours');
        }
      }
      await manager.query(PURCHASE_WALL_ON_SQL, [
        purchase.id,
        shownAsSubprofileId !== null,
        shownAsSubprofileId,
      ]);
      return this.wallStateOf(manager, userId, {
        ...purchase,
        is_on_wall: true,
        is_shown_as_persona: shownAsSubprofileId !== null,
        shown_as_subprofile_id: shownAsSubprofileId,
      });
    });
  }

  /** Contract 3.1 readability: a release or a track the caller can read, or
   *  404 `studio_purchase_item_not_found`. */
  private async readItem(
    userId: string,
    releaseId: string | null,
    trackId: string | null,
  ): Promise<ItemForViewer> {
    const rows: ItemForViewerRow[] =
      trackId === null
        ? await this.dataSource.query(RELEASE_FOR_VIEWER_SQL, [
            releaseId,
            userId,
          ])
        : await this.dataSource.query(TRACK_FOR_VIEWER_SQL, [trackId, userId]);
    const row = rows[0];
    if (!row) {
      throw studioError('studio_purchase_item_not_found');
    }
    return { row, trackId: trackId === null ? null : (row.track_id ?? null) };
  }

  private async readFacts(
    userId: string,
    item: ItemForViewer,
  ): Promise<OfferFactsRow> {
    const rows: OfferFactsRow[] = await this.dataSource.query(OFFER_FACTS_SQL, [
      item.row.release_id,
      item.trackId,
      userId,
    ]);
    const facts = rows[0];
    if (!facts) {
      throw studioError('studio_purchase_item_not_found');
    }
    return facts;
  }

  private async offerFor(
    userId: string,
    item: ItemForViewer,
  ): Promise<StudioOffer> {
    const factsRow = await this.readFacts(userId, item);
    const facts = offerFactsOf(item, factsRow);
    const { state, refusalCode } = studioOfferState(facts);
    const purchaseIds = [
      factsRow.pending_purchase_id,
      factsRow.owned_purchase_id,
    ].filter((purchaseId): purchaseId is string => purchaseId !== null);
    const purchasesById = new Map(
      (await this.buyerPurchases.readByIds(userId, purchaseIds)).map(
        (purchase) => [purchase.id, purchase],
      ),
    );
    const personaId = item.row.artist_id;
    // A block between the viewer and the artist hides the payment methods in
    // every state, a pending purchase included.
    const paymentMethods =
      !factsRow.is_blocked && (state === 'can_buy' || state === 'pending')
        ? await this.paymentMethodsOf(personaId)
        : [];
    const identityOptions =
      state === 'can_buy'
        ? (await this.identityOptionsFor(this.dataSource, userId, personaId))
            .options
        : [];
    const offer: StudioOffer = {
      item: {
        kind: item.trackId === null ? 'release' : 'track',
        title: item.row.track_title ?? item.row.release_title,
        releaseId: item.row.release_id,
        trackId: item.trackId,
        releaseType: item.row.release_type,
        coverUrl: toImageUrl(item.row.release_cover_key),
        isAvailable: true,
      },
      artist: artistRefFromColumns(personaColumnsFromRow(item.row, 'artist')),
      price: toStudioPrice(item.row.price_mode, item.row.price_cents),
      viewer: {
        state,
        refusalCode,
        pendingPurchase:
          purchasesById.get(factsRow.pending_purchase_id ?? '') ?? null,
        ownedPurchase:
          purchasesById.get(factsRow.owned_purchase_id ?? '') ?? null,
      },
      paymentMethods,
      identityOptions,
    };
    if (item.trackId === null) {
      offer.trackOffers = await this.trackOffersOf(userId, item, facts);
    }
    return offer;
  }

  private async paymentMethodsOf(
    personaId: string,
  ): Promise<StudioPaymentMethodResponse[]> {
    const rows: PaymentMethodRow[] = await this.dataSource.query(
      PERSONA_PAYMENT_METHODS_SQL,
      [personaId],
    );
    return rows.map(toPaymentMethod);
  }

  /** The priced tracks of a release offer, each through the 3.1 rules. */
  private async trackOffersOf(
    userId: string,
    item: ItemForViewer,
    releaseFacts: StudioOfferFacts,
  ): Promise<StudioTrackOffer[]> {
    const rows: TrackOfferRow[] = await this.dataSource.query(
      RELEASE_TRACK_OFFERS_SQL,
      [item.row.release_id, userId],
    );
    return rows.flatMap((row): StudioTrackOffer[] => {
      const price = toStudioPrice(row.price_mode, row.price_cents);
      if (price === null) return [];
      const { state, refusalCode } = studioOfferState({
        ...releaseFacts,
        priceMode: row.price_mode,
        isOwned: row.is_owned,
        hasPendingClaim: row.pending_purchase_id !== null,
        isTrackOffer: true,
        isTrackWithheld: row.is_track_withheld,
        hasPlayableAudio: row.has_playable_audio,
      });
      return [
        {
          trackId: row.track_id,
          position: Number(row.track_position),
          title: row.track_title,
          price,
          state,
          refusalCode,
          pendingPurchaseId: row.pending_purchase_id,
          ownedPurchaseId: row.owned_purchase_id,
        },
      ];
    });
  }

  /** "Your account" first, then every persona the caller is a member of
   *  (the artist persona left out). A gone artist persona reads as the nil
   *  uuid. */
  private async identityOptionsFor(
    queryable: Queryable,
    userId: string,
    artistPersonaId: string | null,
  ): Promise<{
    options: StudioSupporterOption[];
    member: MemberRef | undefined;
    personasById: Map<string, SupporterPersonaRow>;
  }> {
    const personaRows: SupporterPersonaRow[] = await queryable.query(
      MEMBER_PERSONAS_SQL,
      [userId, artistPersonaId ?? NIL_UUID, null],
    );
    const members = await new MemberLookup(this.profiles).byUserIds([userId]);
    const member = members.get(userId);
    const personasById = new Map(
      personaRows.map((personaRow) => [personaRow.id, personaRow]),
    );
    const options = [null, ...personaRows.map((personaRow) => personaRow.id)]
      .map((shownAsSubprofileId) => ({
        shownAsSubprofileId,
        identity: toStudioSupporterIdentity(
          shownAsSubprofileId,
          member,
          personasById,
        ),
      }))
      .flatMap(({ shownAsSubprofileId, identity }): StudioSupporterOption[] =>
        identity ? [{ shownAsSubprofileId, identity }] : [],
      );
    return { options, member, personasById };
  }

  /** A chosen persona resolves while it is among the caller's options: the
   *  caller is still a member, and it is neither removed nor hidden. */
  private async wallStateOf(
    queryable: Queryable,
    userId: string,
    purchase: OwnPurchaseRow,
  ): Promise<StudioPurchaseWallState> {
    const { options, member, personasById } = await this.identityOptionsFor(
      queryable,
      userId,
      purchase.subprofile_id,
    );
    const chosenPersonaId = purchase.is_shown_as_persona
      ? purchase.shown_as_subprofile_id
      : null;
    const isChosenPersonaGone =
      purchase.is_shown_as_persona &&
      (chosenPersonaId === null || !personasById.has(chosenPersonaId));
    return {
      isOnWall: purchase.is_on_wall,
      shownAsSubprofileId: chosenPersonaId,
      shownAs: isChosenPersonaGone
        ? null
        : toStudioSupporterIdentity(chosenPersonaId, member, personasById),
      needsNewIdentity: purchase.is_on_wall && isChosenPersonaGone,
      options,
    };
  }

  /** Takes the purchase row lock first, then checks the buyer: 404
   *  `studio_purchase_not_found` for a missing row or another member's. */
  private async lockOwnPurchase(
    manager: EntityManager,
    userId: string,
    purchaseId: string,
  ): Promise<OwnPurchaseRow> {
    const rows: OwnPurchaseRow[] = await manager.query(LOCK_OWN_PURCHASE_SQL, [
      purchaseId,
    ]);
    const purchase = rows[0];
    if (!purchase || purchase.buyer_user_id !== userId) {
      throw studioError('studio_purchase_not_found');
    }
    return purchase;
  }

  /** One insert. A unique violation names its reason; anything else is
   *  rethrown as it came. */
  private async insertPurchase(parameters: unknown[]): Promise<string> {
    try {
      const rows: { id: string }[] = await this.dataSource.query(
        PURCHASE_INSERT_SQL,
        parameters,
      );
      const inserted = rows[0];
      if (!inserted) {
        throw new Error('The purchase insert returned no row');
      }
      return inserted.id;
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint === REFERENCE_CODE_CONSTRAINT) {
        throw studioError('studio_purchase_reference_taken');
      }
      if (constraint !== null && PENDING_CLAIM_CONSTRAINTS.has(constraint)) {
        throw studioError('studio_purchase_pending_exists');
      }
      if (
        PURCHASE_ITEM_FOREIGN_KEYS.some((foreignKey) =>
          isForeignKeyViolation(error, foreignKey),
        )
      ) {
        throw studioError('studio_purchase_item_not_found');
      }
      throw error;
    }
  }
}

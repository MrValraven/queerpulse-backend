import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { CreateStudioPurchaseDto } from './dto/create-studio-purchase.dto';
import { StudioBuyerPurchasesService } from './studio-buyer-purchases.service';
import { PERSONA_PAYMENT_METHODS_SQL } from './studio-payment-methods.service';
import { STUDIO_PURCHASE_CLAIMED } from './studio-purchase.events';
import {
  deriveStudioPurchaseReferenceKey,
  isStudioPurchaseReferenceValid,
  signStudioPurchaseReference,
} from './studio-purchase-reference';
import {
  RELEASE_FOR_VIEWER_SQL,
  TRACK_FOR_VIEWER_SQL,
} from './studio-purchase-rows';
import {
  LOCK_OWN_PURCHASE_SQL,
  NIL_UUID,
  OFFER_FACTS_SQL,
  OWN_PURCHASE_SQL,
  PURCHASE_CANCEL_SQL,
  PURCHASE_INSERT_SQL,
  PURCHASE_WALL_OFF_SQL,
  PURCHASE_WALL_ON_SQL,
  RELEASE_TRACK_OFFERS_SQL,
  StudioPurchasesService,
} from './studio-purchases.service';
import { StudioBuyerPurchase } from './studio-purchases-response';
import { SupporterPersonaRow } from './studio-supporters';
import { MEMBER_PERSONAS_SQL } from './studio-supporters.service';

const USER_ID = 'fa000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = 'fa000000-0000-4000-8000-000000000002';
const RELEASE_ID = 'fa000000-0000-4000-8000-000000000101';
const TRACK_ID = 'fa000000-0000-4000-8000-000000000102';
const WITHHELD_TRACK_ID = 'fa000000-0000-4000-8000-000000000103';
const OWNED_TRACK_ID = 'fa000000-0000-4000-8000-000000000104';
const PERSONA_ID = 'fa000000-0000-4000-8000-000000000201';
const WALL_PERSONA_ID = 'fa000000-0000-4000-8000-000000000202';
const PURCHASE_ID = 'fa000000-0000-4000-8000-000000000301';
const OWNED_PURCHASE_ID = 'fa000000-0000-4000-8000-000000000302';
const NEW_PURCHASE_ID = 'fa000000-0000-4000-8000-000000000303';

const SERVER_SECRET = 'purchases-spec-server-secret';
const REFERENCE_KEY = deriveStudioPurchaseReferenceKey(SERVER_SECRET, 'test');
const REFERENCE_CODE = 'QP7K3F';

/** A token for `userId` and the code, valid for an hour. */
function referenceTokenFor(userId: string): string {
  return signStudioPurchaseReference(
    REFERENCE_KEY,
    userId,
    REFERENCE_CODE,
    Math.floor(Date.now() / 1000) + 3600,
  );
}

function releaseRow(): Record<string, unknown> {
  return {
    release_id: RELEASE_ID,
    release_title: 'Low tide',
    release_type: 'album',
    release_status: 'published',
    release_cover_key: null,
    artist_id: PERSONA_ID,
    artist_handle: 'night-shift',
    artist_display_name: 'Night Shift',
    artist_kind: 'musician',
    artist_avatar_url: null,
    price_mode: 'fixed',
    price_cents: 700,
    is_member: false,
  };
}

function trackRow(): Record<string, unknown> {
  return {
    ...releaseRow(),
    track_id: TRACK_ID,
    track_title: 'Harbour',
    track_position: 1,
    is_track_withheld: false,
    has_playable_audio: true,
    price_mode: 'name_your_price',
    price_cents: 100,
    release_price_mode: 'fixed',
    release_price_cents: 700,
  };
}

function factsRow(): Record<string, unknown> {
  return {
    is_owned: false,
    owned_purchase_id: null,
    pending_purchase_id: null,
    is_blocked: false,
    payment_method_count: 1,
  };
}

const PAYMENT_METHOD_ROW = {
  id: 'fa000000-0000-4000-8000-000000000401',
  kind: 'link',
  label: 'Bandcamp tips',
  value: 'https://pay.example/night-shift',
  note: null,
  position: 0,
  updated_at: new Date('2026-10-20T10:00:00.000Z'),
};

const WALL_PERSONA_ROW: SupporterPersonaRow = {
  id: WALL_PERSONA_ID,
  handle: 'paper-lanterns',
  display_name: 'Paper Lanterns',
  kind: 'writer',
  avatar_url: null,
  is_linkable: true,
};

const BUYER_PROFILE: Partial<Profile> = {
  userId: USER_ID,
  slug: 'ana',
  firstName: 'Ana',
  lastName: 'S',
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
};

function buyerPurchaseOf(purchaseId: string): StudioBuyerPurchase {
  return {
    id: purchaseId,
    status: 'pending',
    item: {
      kind: 'release',
      title: 'Low tide',
      releaseId: RELEASE_ID,
      trackId: null,
      releaseType: 'album',
      coverUrl: null,
      isAvailable: true,
    },
    artist: {
      name: 'Night Shift',
      subprofileId: PERSONA_ID,
      handle: 'night-shift',
      isLinkable: true,
    },
    amountCents: 700,
    referenceCode: REFERENCE_CODE,
    payerName: null,
    declineReason: null,
    declineNote: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    decidedAt: null,
    wall: { isOnWall: false, shownAs: null, needsNewIdentity: false },
    downloads: [],
  };
}

function ownPurchaseRow(): Record<string, unknown> {
  return {
    id: PURCHASE_ID,
    buyer_user_id: USER_ID,
    subprofile_id: PERSONA_ID,
    status: 'pending',
    is_on_wall: false,
    is_shown_as_persona: false,
    shown_as_subprofile_id: null,
  };
}

function createBody(
  overrides: Partial<CreateStudioPurchaseDto> = {},
): CreateStudioPurchaseDto {
  return {
    releaseId: RELEASE_ID,
    amountCents: 700,
    isOnWall: false,
    shownAsSubprofileId: null,
    referenceCode: REFERENCE_CODE,
    referenceToken: referenceTokenFor(USER_ID),
    ...overrides,
  };
}

/** The response body of a refused call. */
async function refusalBodyOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getResponse();
    }
    throw error;
  }
  throw new Error('The call resolved; a refusal was expected');
}

function refusal(code: string, statusCode: number): unknown {
  return expect.objectContaining({ code, statusCode });
}

describe('StudioPurchasesService', () => {
  let releaseRows: Record<string, unknown>[];
  let trackRows: Record<string, unknown>[];
  let factsRows: Record<string, unknown>[];
  let trackOfferRows: Record<string, unknown>[];
  let memberPersonaRows: SupporterPersonaRow[];
  let ownRows: Record<string, unknown>[];
  let insertOutcome: () => Promise<unknown>;
  let query: jest.Mock;
  let transaction: jest.Mock;
  let readByIds: jest.Mock;
  let emit: jest.Mock;
  let service: StudioPurchasesService;

  const sqlCalled = (): string[] =>
    query.mock.calls.map((call: unknown[]) => call[0] as string);
  const parametersOf = (sql: string): unknown[][] =>
    query.mock.calls
      .filter((call: unknown[]) => call[0] === sql)
      .map((call: unknown[]) => call[1] as unknown[]);

  beforeEach(() => {
    releaseRows = [releaseRow()];
    trackRows = [trackRow()];
    factsRows = [factsRow()];
    trackOfferRows = [];
    memberPersonaRows = [WALL_PERSONA_ROW];
    ownRows = [ownPurchaseRow()];
    insertOutcome = () => Promise.resolve([{ id: NEW_PURCHASE_ID }]);
    query = jest.fn((sql: string) => {
      switch (sql) {
        case RELEASE_FOR_VIEWER_SQL:
          return Promise.resolve(releaseRows);
        case TRACK_FOR_VIEWER_SQL:
          return Promise.resolve(trackRows);
        case OFFER_FACTS_SQL:
          return Promise.resolve(factsRows);
        case RELEASE_TRACK_OFFERS_SQL:
          return Promise.resolve(trackOfferRows);
        case PERSONA_PAYMENT_METHODS_SQL:
          return Promise.resolve([PAYMENT_METHOD_ROW]);
        case MEMBER_PERSONAS_SQL:
          return Promise.resolve(memberPersonaRows);
        case PURCHASE_INSERT_SQL:
          return insertOutcome();
        case OWN_PURCHASE_SQL:
        case LOCK_OWN_PURCHASE_SQL:
          return Promise.resolve(ownRows);
        default:
          return Promise.resolve([]);
      }
    });
    transaction = jest.fn(
      (work: (manager: { query: jest.Mock }) => Promise<unknown>) =>
        work({ query }),
    );
    readByIds = jest.fn((_userId: string, purchaseIds: string[]) =>
      Promise.resolve(purchaseIds.map(buyerPurchaseOf)),
    );
    emit = jest.fn();
    const config = {
      get: jest.fn((key: string) =>
        key === 'auth.jwtAccessSecret' ? SERVER_SECRET : 'test',
      ),
    };
    service = new StudioPurchasesService(
      { query, transaction } as unknown as DataSource,
      {
        find: jest.fn().mockResolvedValue([BUYER_PROFILE]),
      } as unknown as Repository<Profile>,
      { readByIds } as unknown as StudioBuyerPurchasesService,
      { emit } as unknown as EventEmitter2,
      config as unknown as ConfigService,
    );
  });

  it('answers studio_purchase_item_not_found for a release the caller cannot read', async () => {
    releaseRows = [];
    trackRows = [];
    expect(
      await refusalBodyOf(service.releaseOffer(USER_ID, RELEASE_ID)),
    ).toEqual(refusal('studio_purchase_item_not_found', 404));
    expect(await refusalBodyOf(service.trackOffer(USER_ID, TRACK_ID))).toEqual(
      refusal('studio_purchase_item_not_found', 404),
    );
    expect(await refusalBodyOf(service.create(USER_ID, createBody()))).toEqual(
      refusal('studio_purchase_item_not_found', 404),
    );
    expect(sqlCalled()).not.toContain(OFFER_FACTS_SQL);
    expect(sqlCalled()).not.toContain(PURCHASE_INSERT_SQL);
  });

  it('shows payment methods only while the caller can buy or has a pending claim, and identity options only while they can buy', async () => {
    const canBuy = await service.releaseOffer(USER_ID, RELEASE_ID);
    expect(canBuy.viewer).toEqual({
      state: 'can_buy',
      refusalCode: null,
      pendingPurchase: null,
      ownedPurchase: null,
    });
    expect(canBuy.paymentMethods).toEqual([
      {
        id: PAYMENT_METHOD_ROW.id,
        kind: 'link',
        label: 'Bandcamp tips',
        value: 'https://pay.example/night-shift',
        note: null,
        position: 0,
      },
    ]);
    expect(
      canBuy.identityOptions.map((option) => [
        option.shownAsSubprofileId,
        option.identity.kind,
      ]),
    ).toEqual([
      [null, 'account'],
      [WALL_PERSONA_ID, 'persona'],
    ]);
    expect(parametersOf(MEMBER_PERSONAS_SQL)).toEqual([
      [USER_ID, PERSONA_ID, null],
    ]);
    expect(parametersOf(PERSONA_PAYMENT_METHODS_SQL)).toEqual([[PERSONA_ID]]);

    factsRows = [{ ...factsRow(), pending_purchase_id: PURCHASE_ID }];
    const pending = await service.releaseOffer(USER_ID, RELEASE_ID);
    expect(pending.viewer.state).toBe('pending');
    expect(pending.viewer.pendingPurchase?.id).toBe(PURCHASE_ID);
    expect(pending.paymentMethods).toHaveLength(1);
    expect(pending.identityOptions).toEqual([]);

    query.mockClear();
    factsRows = [{ ...factsRow(), is_blocked: true }];
    const blocked = await service.releaseOffer(USER_ID, RELEASE_ID);
    expect(blocked.viewer).toEqual({
      state: 'refused',
      refusalCode: 'studio_purchase_unavailable',
      pendingPurchase: null,
      ownedPurchase: null,
    });
    expect(blocked.paymentMethods).toEqual([]);
    expect(blocked.identityOptions).toEqual([]);
    expect(sqlCalled()).not.toContain(PERSONA_PAYMENT_METHODS_SQL);
    expect(sqlCalled()).not.toContain(MEMBER_PERSONAS_SQL);

    query.mockClear();
    factsRows = [
      { ...factsRow(), is_blocked: true, pending_purchase_id: PURCHASE_ID },
    ];
    const blockedPending = await service.releaseOffer(USER_ID, RELEASE_ID);
    expect(blockedPending.viewer.state).toBe('pending');
    expect(blockedPending.paymentMethods).toEqual([]);
    expect(sqlCalled()).not.toContain(PERSONA_PAYMENT_METHODS_SQL);

    factsRows = [
      {
        ...factsRow(),
        is_owned: true,
        owned_purchase_id: OWNED_PURCHASE_ID,
        payment_method_count: 0,
      },
    ];
    const owned = await service.releaseOffer(USER_ID, RELEASE_ID);
    expect(owned.viewer.state).toBe('owned');
    expect(owned.viewer.ownedPurchase?.id).toBe(OWNED_PURCHASE_ID);
    expect(owned.paymentMethods).toEqual([]);
    expect(readByIds).toHaveBeenLastCalledWith(USER_ID, [OWNED_PURCHASE_ID]);
  });

  it('lists priced tracks on a release offer and leaves trackOffers off a track offer', async () => {
    trackOfferRows = [
      {
        track_id: TRACK_ID,
        track_position: 1,
        track_title: 'Harbour',
        price_mode: 'fixed',
        price_cents: 150,
        is_track_withheld: false,
        has_playable_audio: true,
        is_owned: false,
        owned_purchase_id: null,
        pending_purchase_id: PURCHASE_ID,
      },
      {
        track_id: WITHHELD_TRACK_ID,
        track_position: 2,
        track_title: 'Lights',
        price_mode: 'name_your_price',
        price_cents: 0,
        is_track_withheld: true,
        has_playable_audio: true,
        is_owned: false,
        owned_purchase_id: null,
        pending_purchase_id: null,
      },
      {
        track_id: OWNED_TRACK_ID,
        track_position: 3,
        track_title: 'Flood',
        price_mode: 'fixed',
        price_cents: 200,
        is_track_withheld: false,
        has_playable_audio: true,
        is_owned: true,
        owned_purchase_id: OWNED_PURCHASE_ID,
        pending_purchase_id: null,
      },
    ];
    const releaseOffer = await service.releaseOffer(USER_ID, RELEASE_ID);
    expect(releaseOffer.item).toEqual({
      kind: 'release',
      title: 'Low tide',
      releaseId: RELEASE_ID,
      trackId: null,
      releaseType: 'album',
      coverUrl: null,
      isAvailable: true,
    });
    expect(releaseOffer.price).toEqual({ mode: 'fixed', amountCents: 700 });
    expect(releaseOffer.trackOffers).toEqual([
      {
        trackId: TRACK_ID,
        position: 1,
        title: 'Harbour',
        price: { mode: 'fixed', amountCents: 150 },
        state: 'pending',
        refusalCode: null,
        pendingPurchaseId: PURCHASE_ID,
        ownedPurchaseId: null,
      },
      {
        trackId: WITHHELD_TRACK_ID,
        position: 2,
        title: 'Lights',
        price: { mode: 'name_your_price', amountCents: 0 },
        state: 'refused',
        refusalCode: 'studio_purchase_track_unavailable',
        pendingPurchaseId: null,
        ownedPurchaseId: null,
      },
      {
        trackId: OWNED_TRACK_ID,
        position: 3,
        title: 'Flood',
        price: { mode: 'fixed', amountCents: 200 },
        state: 'owned',
        refusalCode: null,
        pendingPurchaseId: null,
        ownedPurchaseId: OWNED_PURCHASE_ID,
      },
    ]);
    expect(parametersOf(RELEASE_TRACK_OFFERS_SQL)).toEqual([
      [RELEASE_ID, USER_ID],
    ]);

    query.mockClear();
    const trackOffer = await service.trackOffer(USER_ID, TRACK_ID);
    expect(trackOffer).not.toHaveProperty('trackOffers');
    expect(trackOffer.item.kind).toBe('track');
    expect(trackOffer.item.title).toBe('Harbour');
    expect(trackOffer.price).toEqual({
      mode: 'name_your_price',
      amountCents: 100,
    });
    expect(parametersOf(OFFER_FACTS_SQL)).toEqual([
      [RELEASE_ID, TRACK_ID, USER_ID],
    ]);
    expect(sqlCalled()).not.toContain(RELEASE_TRACK_OFFERS_SQL);
  });

  it('answers studio_purchase_item_required unless exactly one item id is sent', async () => {
    expect(
      await refusalBodyOf(
        service.create(USER_ID, createBody({ trackId: TRACK_ID })),
      ),
    ).toEqual(refusal('studio_purchase_item_required', 400));
    expect(
      await refusalBodyOf(
        service.create(USER_ID, createBody({ releaseId: undefined })),
      ),
    ).toEqual(refusal('studio_purchase_item_required', 400));
    expect(query).not.toHaveBeenCalled();
  });

  it('issues a reference code and a token that verifies for the caller, and records nothing', () => {
    const reference = service.issueReference(USER_ID);
    expect(reference.referenceCode).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(
      isStudioPurchaseReferenceValid(
        REFERENCE_KEY,
        USER_ID,
        reference.referenceCode,
        reference.referenceToken,
      ),
    ).toBe(true);
    expect(
      isStudioPurchaseReferenceValid(
        REFERENCE_KEY,
        OTHER_USER_ID,
        reference.referenceCode,
        reference.referenceToken,
      ),
    ).toBe(false);
    expect(Date.parse(reference.expiresAt)).toBeGreaterThan(Date.now());
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses in contract order and names each code', async () => {
    const cases: {
      code: string;
      statusCode: number;
      isTrack?: boolean;
      item?: Record<string, unknown>;
      facts?: Record<string, unknown>;
    }[] = [
      {
        code: 'studio_purchase_own_persona',
        statusCode: 403,
        item: { is_member: true },
        facts: { is_owned: true, owned_purchase_id: OWNED_PURCHASE_ID },
      },
      {
        code: 'studio_purchase_already_owned',
        statusCode: 409,
        item: { price_mode: 'not_for_sale', price_cents: null },
        facts: { is_owned: true, owned_purchase_id: OWNED_PURCHASE_ID },
      },
      {
        code: 'studio_purchase_not_for_sale',
        statusCode: 409,
        item: {
          price_mode: 'not_for_sale',
          price_cents: null,
          release_status: 'draft',
        },
      },
      {
        code: 'studio_purchase_release_not_published',
        statusCode: 409,
        item: { release_status: 'scheduled' },
        facts: { is_blocked: true },
      },
      {
        code: 'studio_purchase_track_unavailable',
        statusCode: 409,
        isTrack: true,
        item: { is_track_withheld: true },
        facts: { is_blocked: true },
      },
      {
        code: 'studio_purchase_unavailable',
        statusCode: 403,
        facts: { is_blocked: true, payment_method_count: 0 },
      },
      {
        code: 'studio_purchase_no_payment_methods',
        statusCode: 409,
        facts: { payment_method_count: 0 },
      },
    ];
    const answers: unknown[] = [];
    for (const refusalCase of cases) {
      releaseRows = [{ ...releaseRow(), ...refusalCase.item }];
      trackRows = [{ ...trackRow(), ...refusalCase.item }];
      factsRows = [{ ...factsRow(), ...refusalCase.facts }];
      const body = refusalCase.isTrack
        ? createBody({ releaseId: undefined, trackId: TRACK_ID })
        : createBody();
      answers.push(await refusalBodyOf(service.create(USER_ID, body)));
    }
    expect(answers).toEqual(
      cases.map((refusalCase) =>
        refusal(refusalCase.code, refusalCase.statusCode),
      ),
    );
    expect(sqlCalled()).not.toContain(PURCHASE_INSERT_SQL);
  });

  it('verifies the reference token before the amount and answers studio_purchase_reference_invalid', async () => {
    const body = createBody({
      amountCents: 800,
      isOnWall: true,
      shownAsSubprofileId: WALL_PERSONA_ID,
      referenceToken: referenceTokenFor(OTHER_USER_ID),
    });
    expect(await refusalBodyOf(service.create(USER_ID, body))).toEqual(
      refusal('studio_purchase_reference_invalid', 400),
    );
    expect(sqlCalled()).not.toContain(MEMBER_PERSONAS_SQL);
    expect(sqlCalled()).not.toContain(PURCHASE_INSERT_SQL);
  });

  it('answers studio_purchase_reference_taken when the reference code index refuses the insert, with one insert only', async () => {
    insertOutcome = () =>
      Promise.reject(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'UQ_studio_purchases_reference_code',
        }),
      );
    expect(await refusalBodyOf(service.create(USER_ID, createBody()))).toEqual(
      refusal('studio_purchase_reference_taken', 409),
    );
    expect(parametersOf(PURCHASE_INSERT_SQL)).toHaveLength(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('stores the verified reference code', async () => {
    await service.create(USER_ID, createBody());
    expect(
      parametersOf(PURCHASE_INSERT_SQL).map((parameters) => parameters[8]),
    ).toEqual([REFERENCE_CODE]);
  });

  it('refuses a changed fixed price with the new price in the body', async () => {
    const error = await service
      .create(USER_ID, {
        releaseId: RELEASE_ID,
        amountCents: 800,
        isOnWall: false,
        shownAsSubprofileId: null,
        referenceCode: REFERENCE_CODE,
        referenceToken: referenceTokenFor(USER_ID),
      })
      .catch((caught: unknown) => caught);
    expect((error as HttpException).getResponse()).toEqual(
      expect.objectContaining({
        code: 'studio_purchase_price_changed',
        statusCode: 409,
        price: { mode: 'fixed', amountCents: 700 },
      }),
    );
    expect(sqlCalled()).not.toContain(PURCHASE_INSERT_SQL);
  });

  it('refuses a wall persona the caller is not a member of', async () => {
    memberPersonaRows = [];
    const body = createBody({
      isOnWall: true,
      shownAsSubprofileId: WALL_PERSONA_ID,
    });
    expect(await refusalBodyOf(service.create(USER_ID, body))).toEqual(
      refusal('studio_supporter_identity_not_yours', 403),
    );
    expect(parametersOf(MEMBER_PERSONAS_SQL)).toEqual([
      [USER_ID, PERSONA_ID, WALL_PERSONA_ID],
    ]);
    expect(sqlCalled()).not.toContain(PURCHASE_INSERT_SQL);
  });

  it('stores snapshots, a plain-text payer name and the account when the wall is off', async () => {
    await service.create(
      USER_ID,
      createBody({
        payerName: ' <b>Ana S</b> ',
        isOnWall: false,
        shownAsSubprofileId: WALL_PERSONA_ID,
      }),
    );
    expect(parametersOf(PURCHASE_INSERT_SQL)).toEqual([
      [
        USER_ID,
        PERSONA_ID,
        'Night Shift',
        'release',
        RELEASE_ID,
        null,
        'Low tide',
        700,
        REFERENCE_CODE,
        'Ana S',
        false,
        false,
        null,
      ],
    ]);
    expect(sqlCalled()).not.toContain(MEMBER_PERSONAS_SQL);
  });

  it('answers studio_purchase_pending_exists when the pending index refuses the insert', async () => {
    insertOutcome = () =>
      Promise.reject(
        Object.assign(new Error('query failed'), {
          driverError: {
            code: '23505',
            constraint: 'UQ_studio_purchases_pending_track',
          },
        }),
      );
    expect(
      await refusalBodyOf(
        service.create(
          USER_ID,
          createBody({ releaseId: undefined, trackId: TRACK_ID }),
        ),
      ),
    ).toEqual(refusal('studio_purchase_pending_exists', 409));

    insertOutcome = () =>
      Promise.reject(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'UQ_studio_purchases_pending_release',
        }),
      );
    expect(await refusalBodyOf(service.create(USER_ID, createBody()))).toEqual(
      refusal('studio_purchase_pending_exists', 409),
    );

    const connectionError = new Error('connection terminated');
    insertOutcome = () => Promise.reject(connectionError);
    await expect(service.create(USER_ID, createBody())).rejects.toBe(
      connectionError,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('answers studio_purchase_item_not_found when the persona, release or track went away before the insert', async () => {
    const outcomes: unknown[] = [];
    for (const foreignKey of [
      'FK_studio_purchases_subprofile',
      'FK_studio_purchases_release',
      'FK_studio_purchases_track',
    ]) {
      insertOutcome = () =>
        Promise.reject(
          Object.assign(new Error('query failed'), {
            driverError: { code: '23503', constraint: foreignKey },
          }),
        );
      outcomes.push(await refusalBodyOf(service.create(USER_ID, createBody())));
    }
    expect(outcomes).toEqual([
      refusal('studio_purchase_item_not_found', 404),
      refusal('studio_purchase_item_not_found', 404),
      refusal('studio_purchase_item_not_found', 404),
    ]);

    const buyerKeyError = Object.assign(new Error('query failed'), {
      code: '23503',
      constraint: 'FK_studio_purchases_buyer',
    });
    insertOutcome = () => Promise.reject(buyerKeyError);
    await expect(service.create(USER_ID, createBody())).rejects.toBe(
      buyerKeyError,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits the claim after the insert and returns the buyer purchase', async () => {
    const purchase = await service.create(USER_ID, createBody());
    expect(purchase).toEqual(buyerPurchaseOf(NEW_PURCHASE_ID));
    expect(emit).toHaveBeenCalledWith(STUDIO_PURCHASE_CLAIMED, {
      purchaseId: NEW_PURCHASE_ID,
    });
    expect(readByIds).toHaveBeenCalledWith(USER_ID, [NEW_PURCHASE_ID]);
    const insertCallIndex = sqlCalled().indexOf(PURCHASE_INSERT_SQL);
    const insertOrder = query.mock.invocationCallOrder[insertCallIndex] ?? 0;
    const emitOrder = emit.mock.invocationCallOrder[0] ?? 0;
    expect(insertOrder).toBeGreaterThan(0);
    expect(emitOrder).toBeGreaterThan(insertOrder);
  });

  it('cancels only its own pending purchase under the row lock', async () => {
    ownRows = [{ ...ownPurchaseRow(), buyer_user_id: OTHER_USER_ID }];
    expect(await refusalBodyOf(service.cancel(USER_ID, PURCHASE_ID))).toEqual(
      refusal('studio_purchase_not_found', 404),
    );
    ownRows = [];
    expect(await refusalBodyOf(service.cancel(USER_ID, PURCHASE_ID))).toEqual(
      refusal('studio_purchase_not_found', 404),
    );
    ownRows = [{ ...ownPurchaseRow(), status: 'confirmed' }];
    expect(await refusalBodyOf(service.cancel(USER_ID, PURCHASE_ID))).toEqual(
      refusal('studio_purchase_not_pending', 409),
    );
    expect(sqlCalled()).toEqual([
      LOCK_OWN_PURCHASE_SQL,
      LOCK_OWN_PURCHASE_SQL,
      LOCK_OWN_PURCHASE_SQL,
    ]);

    query.mockClear();
    ownRows = [ownPurchaseRow()];
    await service.cancel(USER_ID, PURCHASE_ID);
    expect(transaction).toHaveBeenCalledTimes(4);
    expect(query.mock.calls).toEqual([
      [LOCK_OWN_PURCHASE_SQL, [PURCHASE_ID]],
      [PURCHASE_CANCEL_SQL, [PURCHASE_ID]],
    ]);
    expect(LOCK_OWN_PURCHASE_SQL).toMatch(/FOR UPDATE\s*$/);
    expect(PURCHASE_CANCEL_SQL).toContain(`"status" = 'cancelled'`);
    expect(PURCHASE_CANCEL_SQL).toContain(`"decided_at" = now()`);
  });

  it('refuses a wall change on a declined purchase or one whose artist is gone', async () => {
    const body = { isOnWall: true, shownAsSubprofileId: null };
    ownRows = [{ ...ownPurchaseRow(), status: 'declined' }];
    expect(
      await refusalBodyOf(service.updateWall(USER_ID, PURCHASE_ID, body)),
    ).toEqual(refusal('studio_purchase_wall_not_available', 409));
    ownRows = [
      { ...ownPurchaseRow(), status: 'confirmed', subprofile_id: null },
    ];
    expect(
      await refusalBodyOf(service.updateWall(USER_ID, PURCHASE_ID, body)),
    ).toEqual(refusal('studio_purchase_wall_not_available', 409));
    ownRows = [{ ...ownPurchaseRow(), buyer_user_id: OTHER_USER_ID }];
    expect(
      await refusalBodyOf(service.updateWall(USER_ID, PURCHASE_ID, body)),
    ).toEqual(refusal('studio_purchase_not_found', 404));
    expect(sqlCalled()).toEqual([
      LOCK_OWN_PURCHASE_SQL,
      LOCK_OWN_PURCHASE_SQL,
      LOCK_OWN_PURCHASE_SQL,
    ]);
  });

  it('keeps the identity choice when the wall is turned off', async () => {
    ownRows = [
      {
        ...ownPurchaseRow(),
        status: 'confirmed',
        is_on_wall: true,
        is_shown_as_persona: true,
        shown_as_subprofile_id: WALL_PERSONA_ID,
      },
    ];
    const state = await service.updateWall(USER_ID, PURCHASE_ID, {
      isOnWall: false,
      shownAsSubprofileId: null,
    });
    expect(sqlCalled().slice(0, 2)).toEqual([
      LOCK_OWN_PURCHASE_SQL,
      PURCHASE_WALL_OFF_SQL,
    ]);
    expect(parametersOf(PURCHASE_WALL_OFF_SQL)).toEqual([[PURCHASE_ID]]);
    expect(sqlCalled()).not.toContain(PURCHASE_WALL_ON_SQL);
    expect(PURCHASE_WALL_OFF_SQL).toContain(`"is_on_wall" = false`);
    expect(PURCHASE_WALL_OFF_SQL).not.toContain('is_shown_as_persona');
    expect(PURCHASE_WALL_OFF_SQL).not.toContain('shown_as_subprofile_id');
    expect(state).toEqual(
      expect.objectContaining({
        isOnWall: false,
        shownAsSubprofileId: WALL_PERSONA_ID,
        needsNewIdentity: false,
      }),
    );
    expect(state.shownAs?.kind).toBe('persona');
  });

  it('turns the wall on as a persona the caller runs after the row lock', async () => {
    const state = await service.updateWall(USER_ID, PURCHASE_ID, {
      isOnWall: true,
      shownAsSubprofileId: WALL_PERSONA_ID,
    });
    expect(sqlCalled().slice(0, 3)).toEqual([
      LOCK_OWN_PURCHASE_SQL,
      MEMBER_PERSONAS_SQL,
      PURCHASE_WALL_ON_SQL,
    ]);
    expect(parametersOf(PURCHASE_WALL_ON_SQL)).toEqual([
      [PURCHASE_ID, true, WALL_PERSONA_ID],
    ]);
    expect(state).toEqual(
      expect.objectContaining({
        isOnWall: true,
        shownAsSubprofileId: WALL_PERSONA_ID,
        needsNewIdentity: false,
      }),
    );

    memberPersonaRows = [];
    expect(
      await refusalBodyOf(
        service.updateWall(USER_ID, PURCHASE_ID, {
          isOnWall: true,
          shownAsSubprofileId: WALL_PERSONA_ID,
        }),
      ),
    ).toEqual(refusal('studio_supporter_identity_not_yours', 403));
  });

  it('passes the nil uuid to MEMBER_PERSONAS_SQL when the artist persona is gone', async () => {
    ownRows = [
      {
        ...ownPurchaseRow(),
        status: 'confirmed',
        subprofile_id: null,
        is_on_wall: true,
        is_shown_as_persona: true,
        shown_as_subprofile_id: WALL_PERSONA_ID,
      },
    ];
    memberPersonaRows = [];
    const state = await service.getWall(USER_ID, PURCHASE_ID);
    expect(parametersOf(MEMBER_PERSONAS_SQL)).toEqual([
      [USER_ID, NIL_UUID, null],
    ]);
    expect(state).toEqual(
      expect.objectContaining({
        isOnWall: true,
        shownAs: null,
        needsNewIdentity: true,
      }),
    );
    expect(state.options.map((option) => option.shownAsSubprofileId)).toEqual([
      null,
    ]);

    ownRows = [{ ...ownPurchaseRow(), buyer_user_id: OTHER_USER_ID }];
    expect(await refusalBodyOf(service.getWall(USER_ID, PURCHASE_ID))).toEqual(
      refusal('studio_purchase_not_found', 404),
    );
  });
});

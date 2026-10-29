import {
  generateStudioReferenceCode,
  isSellableReleaseType,
  studioAmountRefusal,
  studioArtistNameSnapshot,
  studioCreateRefusal,
  studioDownloadDisplayName,
  studioDownloadFormat,
  studioItemTitleSnapshot,
  studioLiveDownloadRefusal,
  studioOfferState,
  studioPriceShapeRefusal,
  studioTypeChangeRefusal,
  STUDIO_PURCHASE_LIMITS,
  STUDIO_REFERENCE_CODE_ALPHABET,
  toStudioPrice,
  uniqueViolationConstraint,
  type StudioLiveDownloadFacts,
  type StudioOfferFacts,
} from './studio-purchase-rules';
import {
  STUDIO_KEPT_AUDIO_PENDING,
  STUDIO_PURCHASE_CLAIMED,
  STUDIO_PURCHASE_CONFIRMED,
  STUDIO_PURCHASE_DECLINED,
  STUDIO_PURCHASE_EXPIRED,
} from './studio-purchase.events';

describe('studio purchase rules', () => {
  const buyable: StudioOfferFacts = {
    isPersonaMember: false,
    priceMode: 'fixed',
    releaseType: 'album',
    isOwned: false,
    hasPendingClaim: false,
    releaseStatus: 'published',
    isTrackOffer: false,
    isTrackWithheld: false,
    hasPlayableAudio: true,
    isBlocked: false,
    hasPaymentMethods: true,
  };
  const downloadable: StudioLiveDownloadFacts = {
    releaseStatus: 'published',
    isPersonaRemoved: false,
    isPersonaModerated: false,
    isTrackWithheld: false,
    audioKey: 'studio-audio/a/b.mp3',
    audioContentType: 'audio/mpeg',
  };

  it('holds the contract limits and the 31-symbol alphabet with no 0, O, 1, I or L', () => {
    expect(STUDIO_PURCHASE_LIMITS).toEqual({
      fixedPriceMinCents: 100,
      priceMaxCents: 50000,
      minimumPriceMinCents: 0,
      amountMaxCents: 50000,
      payerNameMaxLength: 60,
      declineNoteMaxLength: 200,
      paymentMethodsMax: 8,
      paymentLabelMaxLength: 60,
      paymentValueMaxLength: 500,
      paymentNoteMaxLength: 160,
      artistNameSnapshotMaxLength: 120,
      itemTitleSnapshotMaxLength: 200,
      inboxPerPage: 30,
      salesPerPage: 30,
      purchasesPerPage: 30,
      wallPerPage: 24,
      pendingExpiryDays: 30,
      salesWindowDays: 28,
      downloadUrlExpirySeconds: 900,
    });
    expect(STUDIO_PURCHASE_LIMITS).not.toHaveProperty('referenceCodeAttempts');
    expect(STUDIO_REFERENCE_CODE_ALPHABET).toHaveLength(31);
    expect(STUDIO_REFERENCE_CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it('sells albums, EPs and singles only', () => {
    expect(
      ['album', 'ep', 'single', 'mix', 'podcast', 'edit', 'lip_sync'].map(
        isSellableReleaseType,
      ),
    ).toEqual([true, true, true, false, false, false, false]);
  });

  it('builds a six-character code from the alphabet that the database check accepts', () => {
    expect(generateStudioReferenceCode((max) => max - 1)).toBe('ZZZZZZ');
    expect(generateStudioReferenceCode(() => 0)).toBe('222222');
    for (let attempt = 0; attempt < 200; attempt++) {
      expect(generateStudioReferenceCode()).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    }
  });

  it('reads a stored price and none for an item off sale', () => {
    expect([
      toStudioPrice('fixed', 700),
      toStudioPrice('name_your_price', 0),
      toStudioPrice('not_for_sale', null),
    ]).toEqual([
      { mode: 'fixed', amountCents: 700 },
      { mode: 'name_your_price', amountCents: 0 },
      null,
    ]);
  });

  it('answers own persona first, then owned, then pending, then not for sale', () => {
    expect([
      studioOfferState({ ...buyable, isPersonaMember: true, isOwned: true }),
      studioOfferState({
        ...buyable,
        isOwned: true,
        hasPendingClaim: true,
        priceMode: 'not_for_sale',
      }),
      studioOfferState({
        ...buyable,
        hasPendingClaim: true,
        priceMode: 'not_for_sale',
      }),
      studioOfferState({
        ...buyable,
        priceMode: 'not_for_sale',
        releaseStatus: 'draft',
      }),
      studioOfferState({
        ...buyable,
        priceMode: 'not_for_sale',
        releaseType: 'mix',
      }),
      studioOfferState({
        ...buyable,
        releaseStatus: 'scheduled',
        isBlocked: true,
      }),
      studioOfferState({
        ...buyable,
        isTrackOffer: true,
        isTrackWithheld: true,
        isBlocked: true,
      }),
      studioOfferState({
        ...buyable,
        isTrackOffer: true,
        hasPlayableAudio: false,
      }),
      studioOfferState({
        ...buyable,
        isBlocked: true,
        hasPaymentMethods: false,
      }),
      studioOfferState({ ...buyable, hasPaymentMethods: false }),
      studioOfferState(buyable),
    ]).toEqual([
      { state: 'refused', refusalCode: 'studio_purchase_own_persona' },
      { state: 'owned', refusalCode: null },
      { state: 'pending', refusalCode: null },
      { state: 'refused', refusalCode: 'studio_purchase_not_for_sale' },
      { state: 'refused', refusalCode: 'studio_release_type_not_for_sale' },
      {
        state: 'refused',
        refusalCode: 'studio_purchase_release_not_published',
      },
      { state: 'refused', refusalCode: 'studio_purchase_track_unavailable' },
      { state: 'refused', refusalCode: 'studio_purchase_track_unavailable' },
      { state: 'refused', refusalCode: 'studio_purchase_unavailable' },
      { state: 'refused', refusalCode: 'studio_purchase_no_payment_methods' },
      { state: 'can_buy', refusalCode: null },
    ]);
  });

  it('reads an owned item taken off sale as owned', () => {
    expect(
      studioOfferState({
        ...buyable,
        isOwned: true,
        priceMode: 'not_for_sale',
        releaseStatus: 'draft',
        isBlocked: true,
        hasPaymentMethods: false,
      }),
    ).toEqual({ state: 'owned', refusalCode: null });
  });

  it('refuses a create with rules 1, 2 and 4 to 8 and leaves a pending claim to the unique index', () => {
    expect([
      studioCreateRefusal({ ...buyable, isPersonaMember: true, isOwned: true }),
      studioCreateRefusal({
        ...buyable,
        isOwned: true,
        priceMode: 'not_for_sale',
      }),
      studioCreateRefusal({ ...buyable, hasPendingClaim: true }),
      studioCreateRefusal({
        ...buyable,
        hasPendingClaim: true,
        priceMode: 'not_for_sale',
      }),
      studioCreateRefusal({ ...buyable, hasPaymentMethods: false }),
      studioCreateRefusal(buyable),
    ]).toEqual([
      'studio_purchase_own_persona',
      'studio_purchase_already_owned',
      null,
      'studio_purchase_not_for_sale',
      'studio_purchase_no_payment_methods',
      null,
    ]);
  });

  it('refuses a price on an unsellable type first, then a fixed price under one euro', () => {
    expect([
      studioPriceShapeRefusal({ mode: 'fixed', amountCents: 50 }, 'mix'),
      studioPriceShapeRefusal({ mode: 'fixed', amountCents: 99 }, 'album'),
      studioPriceShapeRefusal(
        { mode: 'name_your_price', amountCents: 0 },
        'single',
      ),
      studioPriceShapeRefusal(null, 'mix'),
    ]).toEqual([
      'studio_release_type_not_for_sale',
      'studio_price_out_of_range',
      null,
      null,
    ]);
  });

  it('refuses a type change to an unsellable type while anything on the release is priced', () => {
    expect([
      studioTypeChangeRefusal({
        isTypeChanging: true,
        releaseTypeAfterWrite: 'mix',
        hasPricedItemsAfterWrite: true,
      }),
      studioTypeChangeRefusal({
        isTypeChanging: true,
        releaseTypeAfterWrite: 'mix',
        hasPricedItemsAfterWrite: false,
      }),
      studioTypeChangeRefusal({
        isTypeChanging: false,
        releaseTypeAfterWrite: 'mix',
        hasPricedItemsAfterWrite: true,
      }),
      studioTypeChangeRefusal({
        isTypeChanging: true,
        releaseTypeAfterWrite: 'ep',
        hasPricedItemsAfterWrite: true,
      }),
    ]).toEqual(['studio_release_type_not_for_sale', null, null, null]);
  });

  it('names the amount refusal for a changed fixed price, a low amount and one over the cap', () => {
    expect([
      studioAmountRefusal({ mode: 'fixed', amountCents: 700 }, 800),
      studioAmountRefusal({ mode: 'name_your_price', amountCents: 300 }, 299),
      studioAmountRefusal({ mode: 'name_your_price', amountCents: 300 }, 50001),
      studioAmountRefusal({ mode: 'name_your_price', amountCents: 0 }, 0),
      studioAmountRefusal({ mode: 'fixed', amountCents: 700 }, 700),
    ]).toEqual([
      'studio_purchase_price_changed',
      'studio_purchase_amount_below_minimum',
      'studio_purchase_amount_above_cap',
      null,
      null,
    ]);
  });

  it('answers the live download refusals in contract order', () => {
    expect([
      studioLiveDownloadRefusal({
        ...downloadable,
        releaseStatus: 'taken_down',
        isTrackWithheld: true,
      }),
      studioLiveDownloadRefusal({
        ...downloadable,
        isPersonaRemoved: true,
        isTrackWithheld: true,
      }),
      studioLiveDownloadRefusal({
        ...downloadable,
        isPersonaModerated: true,
      }),
      studioLiveDownloadRefusal({
        ...downloadable,
        isTrackWithheld: true,
        audioKey: null,
        audioContentType: null,
      }),
      studioLiveDownloadRefusal({ ...downloadable, audioContentType: null }),
      studioLiveDownloadRefusal({ ...downloadable, audioKey: null }),
      studioLiveDownloadRefusal({ ...downloadable, releaseStatus: 'draft' }),
    ]).toEqual([
      'studio_download_release_taken_down',
      'studio_download_artist_unavailable',
      'studio_download_artist_unavailable',
      'studio_download_track_withheld',
      'studio_download_track_not_ready',
      'studio_download_track_not_ready',
      null,
    ]);
  });

  it('maps audio/mpeg to mp3 and audio/mp4 to m4a', () => {
    expect([
      studioDownloadFormat('audio/mpeg'),
      studioDownloadFormat('audio/mp4'),
      studioDownloadFormat('audio/ogg'),
      studioDownloadFormat(null),
    ]).toEqual(['mp3', 'm4a', null, null]);
    expect(studioDownloadDisplayName('Nova', 'Glow')).toBe('Nova - Glow');
  });

  it('snapshots the artist name trimmed, falls back to the handle, and cuts at 120', () => {
    expect([
      studioArtistNameSnapshot('  Nova  ', 'nova'),
      studioArtistNameSnapshot('   ', 'nova'),
      studioArtistNameSnapshot(null, 'nova'),
      Array.from(studioArtistNameSnapshot('é'.repeat(200), 'nova')).length,
      Array.from(studioArtistNameSnapshot('🌈'.repeat(130), null)).length,
      Array.from(studioItemTitleSnapshot('t'.repeat(300))).length,
      studioItemTitleSnapshot('Glow'),
    ]).toEqual(['Nova', 'nova', 'nova', 120, 120, 200, 'Glow']);
  });

  it('reads the constraint of a unique violation on the error or its driver error', () => {
    expect(
      uniqueViolationConstraint({
        code: '23505',
        constraint: 'UQ_studio_purchases_reference_code',
      }),
    ).toBe('UQ_studio_purchases_reference_code');
    expect(
      uniqueViolationConstraint({
        driverError: {
          code: '23505',
          constraint: 'UQ_studio_purchases_pending_track',
        },
      }),
    ).toBe('UQ_studio_purchases_pending_track');
    expect(
      uniqueViolationConstraint({ code: '23503', constraint: 'FK_x' }),
    ).toBeNull();
    expect(uniqueViolationConstraint('boom')).toBeNull();
    expect(uniqueViolationConstraint(null)).toBeNull();
  });

  it('names the four purchase events and the kept audio event', () => {
    expect([
      STUDIO_PURCHASE_CLAIMED,
      STUDIO_PURCHASE_CONFIRMED,
      STUDIO_PURCHASE_DECLINED,
      STUDIO_PURCHASE_EXPIRED,
      STUDIO_KEPT_AUDIO_PENDING,
    ]).toEqual([
      'studio.purchase.claimed',
      'studio.purchase.confirmed',
      'studio.purchase.declined',
      'studio.purchase.expired',
      'studio.kept-audio.pending',
    ]);
  });
});

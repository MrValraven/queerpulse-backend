import {
  StudioPurchaseItemKind,
  StudioPurchaseStatus,
} from './entities/studio-purchase.entity';
import {
  PURCHASE_ROW_SELECT_SQL,
  PurchaseRow,
  RELEASE_FOR_VIEWER_SQL,
  TRACK_FOR_VIEWER_SQL,
  toStudioPurchaseArtist,
  toStudioPurchaseItem,
} from './studio-purchase-rows';

function row(overrides: Partial<PurchaseRow> = {}): PurchaseRow {
  return {
    id: 'purchase-1',
    buyer_user_id: 'buyer-1',
    subprofile_id: 'persona-1',
    artist_name: 'Night Shift (snapshot)',
    item_kind: StudioPurchaseItemKind.Release,
    release_id: 'release-1',
    track_id: null,
    item_title: 'Lisbon at four (snapshot)',
    amount_cents: 700,
    reference_code: 'K7Q2MX',
    payer_name: null,
    status: StudioPurchaseStatus.Confirmed,
    decline_reason: null,
    decline_note: null,
    is_on_wall: false,
    is_shown_as_persona: false,
    shown_as_subprofile_id: null,
    created_at: new Date('2026-10-28T10:00:00.000Z'),
    decided_at: new Date('2026-10-28T11:00:00.000Z'),
    live_release_id: 'release-1',
    live_release_title: 'Lisbon at four',
    live_release_type: 'album',
    live_cover_key: null,
    live_track_title: null,
    live_persona_name: 'Night Shift',
    live_persona_handle: 'night-shift',
    is_persona_linkable: true,
    ...overrides,
  };
}

describe('Studio purchase rows', () => {
  it('reads the live title and artist while they exist', () => {
    expect(
      toStudioPurchaseItem(
        row({
          item_kind: StudioPurchaseItemKind.Track,
          release_id: null,
          track_id: 'track-1',
          live_track_title: 'Opening (remaster)',
          item_title: 'Opening',
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        kind: 'track',
        title: 'Opening (remaster)',
        isAvailable: true,
      }),
    );
    expect(
      toStudioPurchaseArtist(row({ live_persona_name: 'Night Shift' })),
    ).toEqual({
      name: 'Night Shift',
      subprofileId: 'persona-1',
      handle: 'night-shift',
      isLinkable: true,
    });
  });

  it('falls back to the snapshots once the item and the persona are gone', () => {
    expect(
      toStudioPurchaseItem(
        row({
          release_id: null,
          live_release_id: null,
          live_release_title: null,
          item_title: 'Lisbon at four',
        }),
      ),
    ).toEqual({
      kind: 'release',
      title: 'Lisbon at four',
      releaseId: null,
      trackId: null,
      releaseType: null,
      coverUrl: null,
      isAvailable: false,
    });
    expect(
      toStudioPurchaseArtist(
        row({
          subprofile_id: null,
          live_persona_name: null,
          live_persona_handle: null,
          is_persona_linkable: false,
          artist_name: 'Night Shift',
        }),
      ),
    ).toEqual({
      name: 'Night Shift',
      subprofileId: null,
      handle: null,
      isLinkable: false,
    });
  });

  it('uses the handle as the live artist name while the display name is blank', () => {
    expect(toStudioPurchaseArtist(row({ live_persona_name: '   ' }))).toEqual(
      expect.objectContaining({ name: 'night-shift' }),
    );
  });

  it('gives a track purchase the track release id while both exist', () => {
    const liveTrackRow = row({
      item_kind: StudioPurchaseItemKind.Track,
      release_id: null,
      track_id: 'track-1',
      live_track_title: 'Opening',
      live_release_id: 'release-9',
      live_release_type: 'ep',
    });
    expect(toStudioPurchaseItem(liveTrackRow)).toEqual(
      expect.objectContaining({
        releaseId: 'release-9',
        trackId: 'track-1',
        releaseType: 'ep',
      }),
    );
    const deletedTrackRow = row({
      item_kind: StudioPurchaseItemKind.Track,
      release_id: null,
      track_id: null,
      live_track_title: null,
      live_release_id: null,
      live_release_title: null,
      item_title: 'Opening',
    });
    expect(toStudioPurchaseItem(deletedTrackRow)).toEqual(
      expect.objectContaining({
        title: 'Opening',
        releaseId: null,
        trackId: null,
        isAvailable: false,
      }),
    );
  });

  it('reads the release of a track purchase through the track and joins the persona by the purchase', () => {
    expect(PURCHASE_ROW_SELECT_SQL).toContain(
      `COALESCE("purchase"."release_id", "item_track"."release_id")`,
    );
    expect(PURCHASE_ROW_SELECT_SQL).toContain(
      `"item_persona"."id" = "purchase"."subprofile_id"`,
    );
    // Selected once, for the services; the mappers never copy it.
    expect(PURCHASE_ROW_SELECT_SQL.match(/"buyer_user_id"/g)).toHaveLength(1);
  });

  it('never copies the buyer user id to the wire', () => {
    const wire = JSON.stringify([
      toStudioPurchaseItem(row()),
      toStudioPurchaseArtist(row()),
    ]);
    expect(wire).not.toContain('buyer-1');
  });

  it('opens a release to its members at any status and to listeners once listenable', () => {
    expect(RELEASE_FOR_VIEWER_SQL).toContain(
      `"release"."status" = 'published'`,
    );
    expect(RELEASE_FOR_VIEWER_SQL).toMatch(/AS "is_member"/);
    expect(TRACK_FOR_VIEWER_SQL).toContain(`"release"."status" = 'published'`);
    expect(TRACK_FOR_VIEWER_SQL).toMatch(/AS "is_member"/);
  });
});

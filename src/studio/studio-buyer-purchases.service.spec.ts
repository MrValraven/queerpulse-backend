import { DataSource, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import {
  StudioPurchaseItemKind,
  StudioPurchaseStatus,
} from './entities/studio-purchase.entity';
import { decodeStudioCursor, encodeStudioCursor } from './studio-cursor';
import {
  BUYER_PURCHASES_BY_IDS_SQL,
  BUYER_PURCHASES_PAGE_SQL,
  LIVE_DOWNLOAD_TRACKS_SQL,
  StudioBuyerPurchasesService,
  WALL_PERSONAS_SQL,
} from './studio-buyer-purchases.service';
import { KEPT_TRACKS_OF_PURCHASES_SQL } from './studio-kept-tracks';
import { personaMemberUserIdsSql } from './studio-persona-members';
import { PurchaseRow } from './studio-purchase-rows';

const USER_ID = 'fc000000-0000-4000-8000-000000000001';
const PURCHASE_A = 'fc000000-0000-4000-8000-000000000a01';
const PURCHASE_B = 'fc000000-0000-4000-8000-000000000a02';
const PURCHASE_C = 'fc000000-0000-4000-8000-000000000a03';
const PERSONA_ID = 'fc000000-0000-4000-8000-000000000201';

const USER_PROFILE: Partial<Profile> = {
  userId: USER_ID,
  slug: 'sam-lee',
  firstName: 'Sam',
  lastName: 'Lee',
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
};

function purchaseRow(overrides: Partial<PurchaseRow>): PurchaseRow {
  return {
    id: PURCHASE_A,
    buyer_user_id: USER_ID,
    subprofile_id: 'fc000000-0000-4000-8000-000000000301',
    artist_name: 'Night Shift',
    item_kind: StudioPurchaseItemKind.Release,
    release_id: 'fc000000-0000-4000-8000-000000000401',
    track_id: null,
    item_title: 'Lisbon at four',
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
    live_release_id: 'fc000000-0000-4000-8000-000000000401',
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

function liveTrackRow(overrides: Record<string, unknown>) {
  return {
    purchase_id: PURCHASE_A,
    track_id: 'track-1',
    position: 1,
    title: 'Opening',
    duration_seconds: 200,
    audio_key: 'studio-audio/one.mp3',
    audio_content_type: 'audio/mpeg',
    withheld_at: null,
    release_status: 'published',
    persona_removed_at: null,
    is_persona_moderated: false,
    ...overrides,
  };
}

interface Answers {
  purchaseRows: PurchaseRow[];
  keptRows: unknown[];
  liveRows: unknown[];
  personaRows: unknown[];
}

function buildService(answers: Partial<Answers>) {
  const resolved: Answers = {
    purchaseRows: [],
    keptRows: [],
    liveRows: [],
    personaRows: [],
    ...answers,
  };
  const query = jest.fn((sql: string): Promise<unknown[]> => {
    if (
      sql === BUYER_PURCHASES_BY_IDS_SQL ||
      sql === BUYER_PURCHASES_PAGE_SQL
    ) {
      return Promise.resolve(resolved.purchaseRows);
    }
    if (sql === KEPT_TRACKS_OF_PURCHASES_SQL) {
      return Promise.resolve(resolved.keptRows);
    }
    if (sql === LIVE_DOWNLOAD_TRACKS_SQL) {
      return Promise.resolve(resolved.liveRows);
    }
    if (sql === WALL_PERSONAS_SQL) {
      return Promise.resolve(resolved.personaRows);
    }
    throw new Error('Unexpected statement');
  });
  const profileFind = jest.fn(() => Promise.resolve([USER_PROFILE]));
  const service = new StudioBuyerPurchasesService(
    { query } as unknown as DataSource,
    { find: profileFind } as unknown as Repository<Profile>,
  );
  return { service, query };
}

function paramsOf(query: jest.Mock, statement: string): unknown[] | undefined {
  const call = (query.mock.calls as [string, unknown[]][]).find(
    ([sql]) => sql === statement,
  );
  return call?.[1];
}

describe('StudioBuyerPurchasesService', () => {
  it('reads only the caller rows and keeps the order of the ids it was given', async () => {
    const { service, query } = buildService({
      purchaseRows: [
        purchaseRow({ id: PURCHASE_A, status: StudioPurchaseStatus.Pending }),
        purchaseRow({ id: PURCHASE_B, status: StudioPurchaseStatus.Pending }),
      ],
    });
    const purchases = await service.readByIds(USER_ID, [
      PURCHASE_B,
      PURCHASE_A,
    ]);
    expect(purchases.map((purchase) => purchase.id)).toEqual([
      PURCHASE_B,
      PURCHASE_A,
    ]);
    expect(BUYER_PURCHASES_BY_IDS_SQL).toContain('"buyer_user_id" = $1');
    expect(paramsOf(query, BUYER_PURCHASES_BY_IDS_SQL)).toEqual([
      USER_ID,
      [PURCHASE_B, PURCHASE_A],
    ]);
  });

  it('lists confirmed downloads of a release purchase by position and none for a pending one', async () => {
    const { service, query } = buildService({
      purchaseRows: [
        purchaseRow({ id: PURCHASE_A }),
        purchaseRow({ id: PURCHASE_B, status: StudioPurchaseStatus.Pending }),
      ],
      liveRows: [
        liveTrackRow({ track_id: 'track-1', position: 1, title: 'Opening' }),
        liveTrackRow({
          track_id: 'track-2',
          position: 2,
          title: 'Closing',
          duration_seconds: null,
          audio_key: 'studio-audio/two.m4a',
          audio_content_type: 'audio/mp4',
        }),
      ],
    });
    const purchases = await service.readByIds(USER_ID, [
      PURCHASE_A,
      PURCHASE_B,
    ]);
    expect(
      purchases.map((purchase) => [purchase.id, purchase.downloads]),
    ).toEqual([
      [
        PURCHASE_A,
        [
          {
            trackId: 'track-1',
            position: 1,
            title: 'Opening',
            durationSeconds: 200,
            format: 'mp3',
            unavailableReason: null,
          },
          {
            trackId: 'track-2',
            position: 2,
            title: 'Closing',
            durationSeconds: null,
            format: 'm4a',
            unavailableReason: null,
          },
        ],
      ],
      [PURCHASE_B, []],
    ]);
    expect(paramsOf(query, LIVE_DOWNLOAD_TRACKS_SQL)).toEqual([[PURCHASE_A]]);
  });

  it('names each live track that cannot download with the code the route would answer', async () => {
    const { service } = buildService({
      purchaseRows: [purchaseRow({ id: PURCHASE_A })],
      liveRows: [
        liveTrackRow({
          track_id: 'track-1',
          position: 1,
          withheld_at: new Date('2026-10-20T00:00:00.000Z'),
        }),
        liveTrackRow({
          track_id: 'track-2',
          position: 2,
          audio_key: null,
          audio_content_type: null,
        }),
        liveTrackRow({ track_id: 'track-3', position: 3 }),
      ],
    });
    const purchases = await service.readByIds(USER_ID, [PURCHASE_A]);
    expect(
      purchases.flatMap((purchase) =>
        purchase.downloads.map((download) => [
          download.trackId,
          download.format,
          download.unavailableReason,
        ]),
      ),
    ).toEqual([
      ['track-1', 'mp3', 'studio_download_track_withheld'],
      ['track-2', null, 'studio_download_track_not_ready'],
      ['track-3', 'mp3', null],
    ]);
  });

  it('lists kept tracks for a purchase that has kept rows, ahead of any live read', async () => {
    const { service, query } = buildService({
      purchaseRows: [
        purchaseRow({ id: PURCHASE_A, subprofile_id: null, release_id: null }),
        purchaseRow({ id: PURCHASE_B }),
      ],
      keptRows: [
        {
          purchase_id: PURCHASE_A,
          kept_track_id: 'kept-1',
          position: 1,
          title: 'Night Bus',
          duration_seconds: 187,
          audio_content_type: 'audio/mpeg',
          source_audio_key_present: true,
          audio_key: null,
          copy_attempts: 0,
        },
      ],
      liveRows: [liveTrackRow({ purchase_id: PURCHASE_B })],
    });
    const purchases = await service.readByIds(USER_ID, [
      PURCHASE_A,
      PURCHASE_B,
    ]);
    expect(
      purchases.map((purchase) =>
        purchase.downloads.map((download) => [
          download.trackId,
          download.title,
          download.unavailableReason,
        ]),
      ),
    ).toEqual([
      [['kept-1', 'Night Bus', 'studio_download_track_preparing']],
      [['track-1', 'Opening', null]],
    ]);
    expect(paramsOf(query, KEPT_TRACKS_OF_PURCHASES_SQL)).toEqual([
      [PURCHASE_A, PURCHASE_B],
    ]);
    expect(paramsOf(query, LIVE_DOWNLOAD_TRACKS_SQL)).toEqual([[PURCHASE_B]]);
  });

  it('shows the wall identity the buyer chose and asks to pick again once the persona is gone', async () => {
    const { service } = buildService({
      purchaseRows: [
        purchaseRow({
          id: PURCHASE_A,
          status: StudioPurchaseStatus.Pending,
          is_on_wall: true,
          is_shown_as_persona: true,
          shown_as_subprofile_id: null,
        }),
        purchaseRow({
          id: PURCHASE_B,
          status: StudioPurchaseStatus.Pending,
          is_on_wall: true,
          is_shown_as_persona: false,
        }),
        purchaseRow({
          id: PURCHASE_C,
          status: StudioPurchaseStatus.Pending,
          is_on_wall: true,
          is_shown_as_persona: true,
          shown_as_subprofile_id: PERSONA_ID,
        }),
      ],
      personaRows: [
        {
          id: PERSONA_ID,
          handle: 'night-ferry',
          display_name: 'Night Ferry',
          kind: 'developer',
          avatar_url: null,
          is_linkable: true,
        },
      ],
    });
    const purchases = await service.readByIds(USER_ID, [
      PURCHASE_A,
      PURCHASE_B,
      PURCHASE_C,
    ]);
    expect(purchases.map((purchase) => purchase.wall)).toEqual([
      { isOnWall: true, shownAs: null, needsNewIdentity: true },
      {
        isOnWall: true,
        shownAs: {
          kind: 'account',
          member: { slug: 'sam-lee', displayName: 'Sam Lee', avatarUrl: null },
        },
        needsNewIdentity: false,
      },
      {
        isOnWall: true,
        shownAs: {
          kind: 'persona',
          persona: {
            id: PERSONA_ID,
            handle: 'night-ferry',
            name: 'Night Ferry',
            kind: 'developer',
            avatarUrl: null,
            isLinkable: true,
          },
        },
        needsNewIdentity: false,
      },
    ]);
    expect(JSON.stringify(purchases)).not.toContain(USER_ID);
  });

  it('asks to pick again when the chosen persona fails the showable rule', async () => {
    const { service } = buildService({
      purchaseRows: [
        purchaseRow({
          id: PURCHASE_A,
          status: StudioPurchaseStatus.Pending,
          is_on_wall: true,
          is_shown_as_persona: true,
          shown_as_subprofile_id: PERSONA_ID,
        }),
      ],
      personaRows: [],
    });
    const purchases = await service.readByIds(USER_ID, [PURCHASE_A]);
    expect(purchases.map((purchase) => purchase.wall)).toEqual([
      { isOnWall: true, shownAs: null, needsNewIdentity: true },
    ]);
  });

  it('asks to pick again when the buyer left the chosen persona', async () => {
    const { service, query } = buildService({
      purchaseRows: [
        purchaseRow({
          id: PURCHASE_A,
          status: StudioPurchaseStatus.Confirmed,
          is_on_wall: true,
          is_shown_as_persona: true,
          shown_as_subprofile_id: PERSONA_ID,
        }),
      ],
      // The membership filter of WALL_PERSONAS_SQL leaves the persona out.
      personaRows: [],
    });
    const purchases = await service.readByIds(USER_ID, [PURCHASE_A]);
    expect(paramsOf(query, WALL_PERSONAS_SQL)).toEqual([[PERSONA_ID], USER_ID]);
    expect(WALL_PERSONAS_SQL).toContain(
      `$2::uuid IN ${personaMemberUserIdsSql('"shown_persona"."id"')}`,
    );
    expect(purchases.map((purchase) => purchase.wall)).toEqual([
      { isOnWall: true, shownAs: null, needsNewIdentity: true },
    ]);
  });

  it('pages 30 at a time newest first and filters to confirmed when asked', async () => {
    const pageRows = Array.from({ length: 31 }, (_unused, index) =>
      purchaseRow({
        id: `fc000000-0000-4000-8000-0000000b${String(index).padStart(4, '0')}`,
        status: StudioPurchaseStatus.Pending,
        created_at: new Date(Date.UTC(2026, 9, 28, 10, 0, 31 - index)),
      }),
    );
    const { service, query } = buildService({ purchaseRows: pageRows });
    const page = await service.listPage(USER_ID, 'confirmed', undefined);
    expect(page.items).toHaveLength(30);
    expect(page.pageInfo.hasMore).toBe(true);
    const thirtiethRow = pageRows[29];
    expect(decodeStudioCursor(page.pageInfo.nextCursor ?? undefined)).toEqual({
      publishedAt: thirtiethRow?.created_at,
      id: thirtiethRow?.id,
    });
    expect(paramsOf(query, BUYER_PURCHASES_PAGE_SQL)).toEqual([
      USER_ID,
      'confirmed',
      null,
      null,
      31,
    ]);
    expect(BUYER_PURCHASES_PAGE_SQL).toContain(
      'ORDER BY "purchase"."created_at" DESC, "purchase"."id" DESC',
    );
  });

  it('passes the cursor position and no status filter on a later page', async () => {
    const cursor = encodeStudioCursor({
      publishedAt: new Date('2026-10-28T09:00:00.000Z'),
      id: PURCHASE_C,
    });
    const { service, query } = buildService({ purchaseRows: [] });
    const page = await service.listPage(USER_ID, undefined, cursor);
    expect(page).toEqual({
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    expect(paramsOf(query, BUYER_PURCHASES_PAGE_SQL)).toEqual([
      USER_ID,
      null,
      new Date('2026-10-28T09:00:00.000Z'),
      PURCHASE_C,
      31,
    ]);
  });

  it('turns a malformed cursor into the first page', async () => {
    const { service, query } = buildService({ purchaseRows: [] });
    await service.listPage(USER_ID, undefined, 'not-a-cursor');
    expect(paramsOf(query, BUYER_PURCHASES_PAGE_SQL)).toEqual([
      USER_ID,
      null,
      null,
      null,
      31,
    ]);
  });
});

import { HttpException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import {
  StudioPurchaseItemKind,
  StudioPurchaseStatus,
} from './entities/studio-purchase.entity';
import { StudioBuyerPurchasesService } from './studio-buyer-purchases.service';
import { KEPT_TRACK_OF_PURCHASE_SQL, KeptTrackRow } from './studio-kept-tracks';
import {
  DOWNLOAD_LIVE_TRACK_SQL,
  DOWNLOAD_PURCHASE_SQL,
  DownloadLiveTrackRow,
  DownloadPurchaseRow,
  StudioPurchaseLibraryService,
} from './studio-purchase-library.service';
import {
  StudioBuyerPurchase,
  StudioPurchaseDownload,
} from './studio-purchases-response';
import { StudioPage } from './studio-response';

const BUYER_ID = 'fa000000-0000-4000-8000-000000000001';
const OTHER_MEMBER_ID = 'fa000000-0000-4000-8000-000000000002';
const PURCHASE_ID = 'fa000000-0000-4000-8000-000000000101';
const RELEASE_ID = 'fa000000-0000-4000-8000-000000000201';
const OTHER_RELEASE_ID = 'fa000000-0000-4000-8000-000000000202';
const TRACK_ID = 'fa000000-0000-4000-8000-000000000301';
const OTHER_TRACK_ID = 'fa000000-0000-4000-8000-000000000302';
const KEPT_TRACK_ID = 'fa000000-0000-4000-8000-000000000401';
const OTHER_KEPT_TRACK_ID = 'fa000000-0000-4000-8000-000000000402';
const AUDIO_KEY = 'studio-audio/fa000000-0000-4000-8000-000000000501.mp3';
const KEPT_AUDIO_KEY =
  'studio-kept-audio/fa000000-0000-4000-8000-000000000601.m4a';

const SIGNED_DOWNLOAD: StudioPurchaseDownload = {
  url: 'https://bucket.example/signed',
  expiresAt: '2026-10-28T12:15:00.000Z',
  fileName: 'Night Shift - Opening.mp3',
};

function releasePurchaseRow(
  overrides: Partial<DownloadPurchaseRow> = {},
): DownloadPurchaseRow {
  return {
    id: PURCHASE_ID,
    buyer_user_id: BUYER_ID,
    status: StudioPurchaseStatus.Confirmed,
    item_kind: StudioPurchaseItemKind.Release,
    release_id: RELEASE_ID,
    track_id: null,
    artist_name: 'Night Shift Snapshot',
    live_persona_name: 'Night Shift',
    has_kept_tracks: false,
    ...overrides,
  };
}

function liveTrackRow(
  overrides: Partial<DownloadLiveTrackRow> = {},
): DownloadLiveTrackRow {
  return {
    release_id: RELEASE_ID,
    release_status: 'published',
    persona_removed: false,
    is_persona_moderated: false,
    title: 'Opening',
    withheld_at: null,
    audio_key: AUDIO_KEY,
    audio_content_type: 'audio/mpeg',
    ...overrides,
  };
}

function keptTrackRow(overrides: Partial<KeptTrackRow> = {}): KeptTrackRow {
  return {
    purchase_id: PURCHASE_ID,
    kept_track_id: KEPT_TRACK_ID,
    position: 1,
    title: 'Opening (kept)',
    duration_seconds: 201,
    audio_content_type: 'audio/mp4',
    source_audio_key_present: false,
    audio_key: KEPT_AUDIO_KEY,
    copy_attempts: 0,
    ...overrides,
  };
}

interface Fixture {
  purchaseRows: DownloadPurchaseRow[];
  liveTrackRows?: DownloadLiveTrackRow[];
  keptRowsByTrackId?: Record<string, KeptTrackRow[]>;
}

function buildService(fixture: Fixture) {
  const query = jest.fn((sql: string, parameters: unknown[]) => {
    if (sql === DOWNLOAD_PURCHASE_SQL) {
      return Promise.resolve(fixture.purchaseRows);
    }
    if (sql === DOWNLOAD_LIVE_TRACK_SQL) {
      return Promise.resolve(fixture.liveTrackRows ?? []);
    }
    if (sql === KEPT_TRACK_OF_PURCHASE_SQL) {
      const keptTrackId = String(parameters[1]);
      return Promise.resolve(fixture.keptRowsByTrackId?.[keptTrackId] ?? []);
    }
    return Promise.reject(new Error('unexpected statement'));
  });
  const listPage = jest.fn((): Promise<StudioPage<StudioBuyerPurchase>> =>
    Promise.resolve({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    }),
  );
  const createPresignedAudioDownload = jest.fn(() =>
    Promise.resolve(SIGNED_DOWNLOAD),
  );
  const service = new StudioPurchaseLibraryService(
    { query } as unknown as DataSource,
    { listPage } as unknown as StudioBuyerPurchasesService,
    { createPresignedAudioDownload } as unknown as StorageService,
  );
  return { service, query, listPage, createPresignedAudioDownload };
}

/** The refusal code of a call that must throw. */
async function refusalCodeOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse() as { code?: unknown };
      return [error.getStatus(), body.code];
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('StudioPurchaseLibraryService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lists the caller purchases through the shared builder with the status filter', async () => {
    const { service, listPage, query } = buildService({ purchaseRows: [] });

    await service.listMine(BUYER_ID, { status: 'confirmed', cursor: 'abc' });
    await service.listMine(BUYER_ID, {});

    expect(listPage.mock.calls).toEqual([
      [BUYER_ID, 'confirmed', 'abc'],
      [BUYER_ID, undefined, undefined],
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it('answers studio_purchase_not_found for a missing purchase or one of another member', async () => {
    const missing = buildService({ purchaseRows: [] });
    expect(
      await refusalCodeOf(
        missing.service.download(BUYER_ID, PURCHASE_ID, TRACK_ID),
      ),
    ).toEqual([404, 'studio_purchase_not_found']);

    const otherMember = buildService({
      purchaseRows: [releasePurchaseRow({ buyer_user_id: OTHER_MEMBER_ID })],
    });
    expect(
      await refusalCodeOf(
        otherMember.service.download(BUYER_ID, PURCHASE_ID, TRACK_ID),
      ),
    ).toEqual([404, 'studio_purchase_not_found']);

    const erasedBuyer = buildService({
      purchaseRows: [releasePurchaseRow({ buyer_user_id: null })],
    });
    expect(
      await refusalCodeOf(
        erasedBuyer.service.download(BUYER_ID, PURCHASE_ID, TRACK_ID),
      ),
    ).toEqual([404, 'studio_purchase_not_found']);
    expect(otherMember.createPresignedAudioDownload).not.toHaveBeenCalled();
  });

  it('answers studio_purchase_not_confirmed for a pending purchase', async () => {
    const { service, createPresignedAudioDownload } = buildService({
      purchaseRows: [
        releasePurchaseRow({ status: StudioPurchaseStatus.Pending }),
      ],
      liveTrackRows: [liveTrackRow()],
    });

    expect(
      await refusalCodeOf(service.download(BUYER_ID, PURCHASE_ID, TRACK_ID)),
    ).toEqual([409, 'studio_purchase_not_confirmed']);
    expect(createPresignedAudioDownload).not.toHaveBeenCalled();
  });

  it('answers studio_download_item_deleted when the item is gone and no kept rows exist', async () => {
    const releaseGone = buildService({
      purchaseRows: [releasePurchaseRow({ release_id: null })],
    });
    const trackGone = buildService({
      purchaseRows: [
        releasePurchaseRow({
          item_kind: StudioPurchaseItemKind.Track,
          release_id: null,
          track_id: null,
        }),
      ],
    });

    expect([
      await refusalCodeOf(
        releaseGone.service.download(BUYER_ID, PURCHASE_ID, TRACK_ID),
      ),
      await refusalCodeOf(
        trackGone.service.download(BUYER_ID, PURCHASE_ID, TRACK_ID),
      ),
    ]).toEqual([
      [410, 'studio_download_item_deleted'],
      [410, 'studio_download_item_deleted'],
    ]);
  });

  it('answers studio_download_track_removed for a track that left the release or another track', async () => {
    const leftRelease = buildService({
      purchaseRows: [releasePurchaseRow()],
      liveTrackRows: [liveTrackRow({ release_id: OTHER_RELEASE_ID })],
    });
    const deletedTrack = buildService({
      purchaseRows: [releasePurchaseRow()],
      liveTrackRows: [],
    });
    const otherTrack = buildService({
      purchaseRows: [
        releasePurchaseRow({
          item_kind: StudioPurchaseItemKind.Track,
          release_id: null,
          track_id: TRACK_ID,
        }),
      ],
      liveTrackRows: [liveTrackRow()],
    });

    expect([
      await refusalCodeOf(
        leftRelease.service.download(BUYER_ID, PURCHASE_ID, TRACK_ID),
      ),
      await refusalCodeOf(
        deletedTrack.service.download(BUYER_ID, PURCHASE_ID, TRACK_ID),
      ),
      await refusalCodeOf(
        otherTrack.service.download(BUYER_ID, PURCHASE_ID, OTHER_TRACK_ID),
      ),
    ]).toEqual([
      [410, 'studio_download_track_removed'],
      [410, 'studio_download_track_removed'],
      [410, 'studio_download_track_removed'],
    ]);
  });

  it('answers the live refusals in contract order', async () => {
    const cases: Array<[Partial<DownloadLiveTrackRow>, [number, string]]> = [
      [
        {
          release_status: 'taken_down',
          persona_removed: true,
          withheld_at: new Date(),
          audio_key: null,
        },
        [410, 'studio_download_release_taken_down'],
      ],
      [
        { persona_removed: true, withheld_at: new Date(), audio_key: null },
        [410, 'studio_download_artist_unavailable'],
      ],
      [
        {
          is_persona_moderated: true,
          withheld_at: new Date(),
          audio_key: null,
        },
        [410, 'studio_download_artist_unavailable'],
      ],
      [
        { withheld_at: new Date(), audio_key: null },
        [410, 'studio_download_track_withheld'],
      ],
      [{ audio_key: null }, [409, 'studio_download_track_not_ready']],
      [{ audio_content_type: null }, [409, 'studio_download_track_not_ready']],
    ];

    const answers: unknown[] = [];
    for (const [trackOverrides] of cases) {
      const { service } = buildService({
        purchaseRows: [releasePurchaseRow()],
        liveTrackRows: [liveTrackRow(trackOverrides)],
      });
      answers.push(
        await refusalCodeOf(service.download(BUYER_ID, PURCHASE_ID, TRACK_ID)),
      );
    }

    expect(answers).toEqual(cases.map(([, expected]) => expected));
  });

  it('signs a live track with "{artist} - {track}" and its stored content type', async () => {
    const { service, query, createPresignedAudioDownload } = buildService({
      purchaseRows: [releasePurchaseRow()],
      liveTrackRows: [liveTrackRow()],
    });

    expect(await service.download(BUYER_ID, PURCHASE_ID, TRACK_ID)).toEqual(
      SIGNED_DOWNLOAD,
    );
    expect(createPresignedAudioDownload.mock.calls).toEqual([
      [AUDIO_KEY, 'audio/mpeg', 'Night Shift - Opening'],
    ]);
    expect(query.mock.calls).toEqual([
      [DOWNLOAD_PURCHASE_SQL, [PURCHASE_ID]],
      [DOWNLOAD_LIVE_TRACK_SQL, [TRACK_ID]],
    ]);
  });

  it('names the file after the artist snapshot once the paid persona is gone', async () => {
    const { service, createPresignedAudioDownload } = buildService({
      purchaseRows: [
        releasePurchaseRow({
          item_kind: StudioPurchaseItemKind.Track,
          release_id: null,
          track_id: TRACK_ID,
          live_persona_name: null,
        }),
      ],
      liveTrackRows: [liveTrackRow()],
    });

    await service.download(BUYER_ID, PURCHASE_ID, TRACK_ID);

    expect(createPresignedAudioDownload.mock.calls).toEqual([
      [AUDIO_KEY, 'audio/mpeg', 'Night Shift Snapshot - Opening'],
    ]);
  });

  it('downloads a draft release and a private persona and across blocks', async () => {
    const { service, query, createPresignedAudioDownload } = buildService({
      purchaseRows: [releasePurchaseRow()],
      liveTrackRows: [liveTrackRow({ release_status: 'draft' })],
    });

    expect(await service.download(BUYER_ID, PURCHASE_ID, TRACK_ID)).toEqual(
      SIGNED_DOWNLOAD,
    );
    expect(createPresignedAudioDownload).toHaveBeenCalledTimes(1);
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toEqual([
      DOWNLOAD_PURCHASE_SQL,
      DOWNLOAD_LIVE_TRACK_SQL,
    ]);
    expect(statements.some((sql) => /"(identity_)?blocks"/.test(sql))).toBe(
      false,
    );
    expect(DOWNLOAD_LIVE_TRACK_SQL).not.toContain('"visibility"');
  });

  it('answers from kept rows after an unlink and studio_purchase_not_found for a kept id of another purchase', async () => {
    const { service, query, createPresignedAudioDownload } = buildService({
      purchaseRows: [
        releasePurchaseRow({
          release_id: null,
          live_persona_name: null,
          has_kept_tracks: true,
        }),
      ],
      keptRowsByTrackId: { [KEPT_TRACK_ID]: [keptTrackRow()] },
    });

    expect(
      await service.download(BUYER_ID, PURCHASE_ID, KEPT_TRACK_ID),
    ).toEqual(SIGNED_DOWNLOAD);
    expect(
      await refusalCodeOf(
        service.download(BUYER_ID, PURCHASE_ID, OTHER_KEPT_TRACK_ID),
      ),
    ).toEqual([404, 'studio_purchase_not_found']);
    expect(createPresignedAudioDownload.mock.calls).toEqual([
      [KEPT_AUDIO_KEY, 'audio/mp4', 'Night Shift Snapshot - Opening (kept)'],
    ]);
    expect(query.mock.calls).toEqual([
      [DOWNLOAD_PURCHASE_SQL, [PURCHASE_ID]],
      [KEPT_TRACK_OF_PURCHASE_SQL, [PURCHASE_ID, KEPT_TRACK_ID]],
      [DOWNLOAD_PURCHASE_SQL, [PURCHASE_ID]],
      [KEPT_TRACK_OF_PURCHASE_SQL, [PURCHASE_ID, OTHER_KEPT_TRACK_ID]],
    ]);
  });

  it('answers studio_download_track_preparing while the copy is pending and signs the copy once it lands', async () => {
    const keptPurchase = releasePurchaseRow({
      release_id: null,
      live_persona_name: null,
      has_kept_tracks: true,
    });
    const preparing = buildService({
      purchaseRows: [keptPurchase],
      keptRowsByTrackId: {
        [KEPT_TRACK_ID]: [
          keptTrackRow({ audio_key: null, source_audio_key_present: true }),
        ],
      },
    });
    const sourceGone = buildService({
      purchaseRows: [keptPurchase],
      keptRowsByTrackId: {
        [KEPT_TRACK_ID]: [
          keptTrackRow({ audio_key: null, source_audio_key_present: false }),
        ],
      },
    });
    const copyGaveUp = buildService({
      purchaseRows: [keptPurchase],
      keptRowsByTrackId: {
        [KEPT_TRACK_ID]: [
          keptTrackRow({
            audio_key: null,
            source_audio_key_present: true,
            copy_attempts: 10,
          }),
        ],
      },
    });
    const landed = buildService({
      purchaseRows: [keptPurchase],
      keptRowsByTrackId: { [KEPT_TRACK_ID]: [keptTrackRow()] },
    });

    expect([
      await refusalCodeOf(
        preparing.service.download(BUYER_ID, PURCHASE_ID, KEPT_TRACK_ID),
      ),
      await refusalCodeOf(
        sourceGone.service.download(BUYER_ID, PURCHASE_ID, KEPT_TRACK_ID),
      ),
      await refusalCodeOf(
        copyGaveUp.service.download(BUYER_ID, PURCHASE_ID, KEPT_TRACK_ID),
      ),
    ]).toEqual([
      [409, 'studio_download_track_preparing'],
      [409, 'studio_download_track_not_ready'],
      [409, 'studio_download_track_not_ready'],
    ]);
    expect(preparing.createPresignedAudioDownload).not.toHaveBeenCalled();

    await landed.service.download(BUYER_ID, PURCHASE_ID, KEPT_TRACK_ID);
    expect(landed.createPresignedAudioDownload.mock.calls).toEqual([
      [KEPT_AUDIO_KEY, 'audio/mp4', 'Night Shift Snapshot - Opening (kept)'],
    ]);
  });

  it('logs nothing and records nothing about a download', async () => {
    const loggerSpies = (
      ['log', 'warn', 'error', 'debug', 'verbose'] as const
    ).map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined),
    );
    const { service, query } = buildService({
      purchaseRows: [releasePurchaseRow()],
      liveTrackRows: [liveTrackRow()],
    });

    await service.download(BUYER_ID, PURCHASE_ID, TRACK_ID);
    await refusalCodeOf(
      service.download(OTHER_MEMBER_ID, PURCHASE_ID, TRACK_ID),
    );

    expect(loggerSpies.map((spy) => spy.mock.calls.length)).toEqual([
      0, 0, 0, 0, 0,
    ]);
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(
      statements.filter((sql) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql)),
    ).toEqual([]);
  });
});

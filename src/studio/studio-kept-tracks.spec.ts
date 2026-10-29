import {
  KEPT_SOURCE_KEYS_HELD_SQL,
  KEPT_TRACK_OF_PURCHASE_SQL,
  KEPT_TRACKS_OF_PURCHASES_SQL,
  KeptTrackRow,
  keptTrackDownloadRefusal,
  toKeptDownloadTrack,
  withoutKeysHeldByKeptCopies,
} from './studio-kept-tracks';

function keptRow(overrides: Partial<KeptTrackRow>): KeptTrackRow {
  return {
    purchase_id: 'purchase-1',
    kept_track_id: 'kept-1',
    position: 2,
    title: 'Night Bus',
    duration_seconds: 187,
    audio_content_type: 'audio/mpeg',
    source_audio_key_present: false,
    audio_key: 'studio-kept-audio/x.mp3',
    copy_attempts: 0,
    ...overrides,
  };
}

describe('studio kept tracks', () => {
  it('answers preparing while the copy is pending, track_not_ready once the source is gone, and nothing once copied', () => {
    expect([
      keptTrackDownloadRefusal({
        audio_key: null,
        source_audio_key_present: true,
        copy_attempts: 9,
      }),
      keptTrackDownloadRefusal({
        audio_key: null,
        source_audio_key_present: false,
        copy_attempts: 0,
      }),
      keptTrackDownloadRefusal({
        audio_key: 'studio-kept-audio/x.mp3',
        source_audio_key_present: false,
        copy_attempts: 0,
      }),
    ]).toEqual([
      'studio_download_track_preparing',
      'studio_download_track_not_ready',
      null,
    ]);
  });

  it('answers track_not_ready once the copy has used its ten tries', () => {
    expect([
      keptTrackDownloadRefusal({
        audio_key: null,
        source_audio_key_present: true,
        copy_attempts: 10,
      }),
      keptTrackDownloadRefusal({
        audio_key: null,
        source_audio_key_present: true,
        copy_attempts: 11,
      }),
    ]).toEqual([
      'studio_download_track_not_ready',
      'studio_download_track_not_ready',
    ]);
    expect(KEPT_TRACK_OF_PURCHASE_SQL).toContain(
      '"kept"."copy_attempts" AS "copy_attempts"',
    );
  });

  it('drops the keys a pending kept copy still reads', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ source_audio_key: 'studio-audio/held.mp3' }]);

    const deletableKeys = await withoutKeysHeldByKeptCopies({ query }, [
      'studio-audio/held.mp3',
      'studio-audio/free.mp3',
    ]);

    expect(deletableKeys).toEqual(['studio-audio/free.mp3']);
    expect(query.mock.calls).toEqual([
      [
        KEPT_SOURCE_KEYS_HELD_SQL,
        [['studio-audio/held.mp3', 'studio-audio/free.mp3']],
      ],
    ]);
    expect(KEPT_SOURCE_KEYS_HELD_SQL).toContain('"audio_key" IS NULL');
    expect(KEPT_SOURCE_KEYS_HELD_SQL).toContain('"copy_attempts" < 10');
  });

  it('keeps every key when the held check fails, and asks nothing for no keys', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection lost'));

    expect([
      await withoutKeysHeldByKeptCopies({ query }, ['studio-audio/x.mp3']),
      await withoutKeysHeldByKeptCopies({ query }, []),
    ]).toEqual([[], []]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('maps a kept row to a download track keyed by the kept id', () => {
    expect([
      toKeptDownloadTrack(keptRow({})),
      toKeptDownloadTrack(
        keptRow({
          kept_track_id: 'kept-2',
          position: 3,
          title: 'Dawn',
          duration_seconds: null,
          audio_content_type: 'audio/mp4',
          audio_key: null,
          source_audio_key_present: true,
        }),
      ),
    ]).toEqual([
      {
        trackId: 'kept-1',
        position: 2,
        title: 'Night Bus',
        durationSeconds: 187,
        format: 'mp3',
        unavailableReason: null,
      },
      {
        trackId: 'kept-2',
        position: 3,
        title: 'Dawn',
        durationSeconds: null,
        format: 'm4a',
        unavailableReason: 'studio_download_track_preparing',
      },
    ]);
  });

  it('never selects the source key', () => {
    const presenceExpression = `"kept"."source_audio_key" IS NOT NULL AS "source_audio_key_present"`;
    for (const statement of [
      KEPT_TRACKS_OF_PURCHASES_SQL,
      KEPT_TRACK_OF_PURCHASE_SQL,
    ]) {
      expect(statement).toContain(presenceExpression);
      expect(statement.split(presenceExpression).join('')).not.toContain(
        'source_audio_key',
      );
    }
  });

  it('orders the list by purchase, position and kept id, and filters the single read by both ids', () => {
    expect(KEPT_TRACKS_OF_PURCHASES_SQL).toContain(
      `ORDER BY "link"."purchase_id" ASC, "link"."position" ASC, "kept"."id" ASC`,
    );
    expect(KEPT_TRACK_OF_PURCHASE_SQL).toContain(
      `"link"."purchase_id" = $1::uuid`,
    );
    expect(KEPT_TRACK_OF_PURCHASE_SQL).toContain(
      `"link"."kept_track_id" = $2::uuid`,
    );
  });
});

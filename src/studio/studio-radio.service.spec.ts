import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StudioRadioService, radioSql } from './studio-radio.service';

const VIEWER_ID = 'f5000000-0000-4000-8000-000000000001';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const radioRow = {
  track_id: 'f5000000-0000-4000-8000-000000000011',
  title: 'Opening',
  duration_seconds: 241,
  is_explicit: false,
  release_id: 'f5000000-0000-4000-8000-000000000021',
  release_title: 'Lisbon at four',
  cover_key: null,
  artist_id: 'f5000000-0000-4000-8000-000000000031',
  artist_handle: 'night-shift',
  artist_display_name: 'Night Shift',
  artist_kind: 'dj',
  artist_avatar_url: null,
};

describe('StudioRadioService', () => {
  let query: jest.Mock;
  let service: StudioRadioService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([radioRow]);
    service = new StudioRadioService({ query } as unknown as DataSource);
  });

  it('answers a flat queue for a genre, capped at 300', async () => {
    const radio = await service.getRadio(VIEWER_ID, { genre: 'electronic' });

    expect(query).toHaveBeenCalledWith(radioSql('genre'), [
      VIEWER_ID,
      'electronic',
      300,
    ]);
    expect(radio).toEqual({
      items: [
        {
          trackId: 'f5000000-0000-4000-8000-000000000011',
          title: 'Opening',
          durationSeconds: 241,
          isExplicit: false,
          releaseId: 'f5000000-0000-4000-8000-000000000021',
          releaseTitle: 'Lisbon at four',
          coverUrl: null,
          artist: {
            id: 'f5000000-0000-4000-8000-000000000031',
            handle: 'night-shift',
            name: 'Night Shift',
            kind: 'dj',
            avatarUrl: null,
          },
        },
      ],
    });
  });

  it('filters on the mood column for a mood', async () => {
    await service.getRadio(VIEWER_ID, { mood: 'late-night' });
    expect(query).toHaveBeenCalledWith(radioSql('mood'), [
      VIEWER_ID,
      'late-night',
      300,
    ]);
    expect(radioSql('mood')).toContain('"release"."mood" = $2');
  });

  it('refuses neither filter and both filters', async () => {
    expect(await codeOf(service.getRadio(VIEWER_ID, {}))).toBe(
      'studio_radio_filter_required',
    );
    expect(
      await codeOf(
        service.getRadio(VIEWER_ID, { genre: 'electronic', mood: 'tender' }),
      ),
    ).toBe('studio_radio_filter_required');
    expect(query).not.toHaveBeenCalled();
  });

  it('samples playable tracks of listenable releases at random, blocks applied', () => {
    const sql = radioSql('genre');
    expect(sql).toContain('"release"."genre" = $2');
    expect(sql).toContain(`"release"."status" = 'published'`);
    expect(sql).toContain('"track"."audio_key" IS NOT NULL');
    expect(sql).toContain('"track"."duration_seconds" IS NOT NULL');
    expect(sql).toContain('content_moderation');
    expect(sql).toContain('FROM "blocks" "radio_block"');
    expect(sql).toContain('ORDER BY random()');
    expect(sql).toContain('LIMIT $3');
    expect(sql).not.toContain('"persona"."user_id" AS');
  });

  // Nothing about the queue is stored: the read writes nothing.
  it('runs one read and no write', async () => {
    await service.getRadio(VIEWER_ID, { genre: 'electronic' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(radioSql('genre')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
  // Studio artist kinds: a radio never plays an episode.
  it('leaves podcast episodes out of every radio', () => {
    for (const filterColumn of ['genre', 'mood'] as const) {
      expect(radioSql(filterColumn)).toContain(`"release"."type" <> 'podcast'`);
    }
  });
});

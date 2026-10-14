import { BadRequestException, HttpException } from '@nestjs/common';
import {
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import {
  assertLyricsWithinFormat,
  hasEverySource,
  notesForTrack,
  sourcesForTrack,
} from './studio-track-content-rule';

const SOURCE = { title: 'Rumour Has It', artist: 'Adele' };

function thrownBy(work: () => unknown): HttpException | undefined {
  try {
    work();
    return undefined;
  } catch (error) {
    return error as HttpException;
  }
}

function codeOf(work: () => unknown): string | undefined {
  const error = thrownBy(work);
  return error
    ? ((error.getResponse() as { code?: string }).code ?? undefined)
    : undefined;
}

describe('Studio track content rule', () => {
  describe('assertLyricsWithinFormat', () => {
    it('takes a 60000 character transcript on podcasts and spoken word', () => {
      expect(
        thrownBy(() => assertLyricsWithinFormat('t'.repeat(60000), 'podcast')),
      ).toBeUndefined();
      expect(
        thrownBy(() =>
          assertLyricsWithinFormat('t'.repeat(60000), 'spoken_word'),
        ),
      ).toBeUndefined();
    });

    it('answers longer text with a 400 in the validation shape', () => {
      const tooLong = thrownBy(() =>
        assertLyricsWithinFormat('t'.repeat(10001), 'music'),
      );
      expect(tooLong).toBeInstanceOf(BadRequestException);
      expect(tooLong?.getResponse()).toEqual({
        statusCode: 400,
        message: ['lyrics must be shorter than or equal to 10000 characters'],
        error: 'Bad Request',
      });
      expect(
        thrownBy(() => assertLyricsWithinFormat('t'.repeat(60001), 'podcast')),
      ).toBeInstanceOf(BadRequestException);
    });

    it('lets cleared lyrics through', () => {
      expect(
        thrownBy(() => assertLyricsWithinFormat(null, 'music')),
      ).toBeUndefined();
    });
  });

  describe('notesForTrack', () => {
    const show = { type: StudioReleaseType.Podcast };

    it('keeps notes on an episode as written and stores blank notes as none', () => {
      expect(notesForTrack('00:00 Intro\n01:30 Housing', show)).toBe(
        '00:00 Intro\n01:30 Housing',
      );
      expect(notesForTrack('   ', show)).toBeNull();
      expect(notesForTrack(null, show)).toBeNull();
    });

    it('refuses notes on a track of another type and lets a clear through', () => {
      const album = { type: StudioReleaseType.Album };
      expect(codeOf(() => notesForTrack('Liner notes', album))).toBe(
        'studio_not_a_podcast',
      );
      expect(notesForTrack(null, album)).toBeNull();
      expect(notesForTrack('  ', album)).toBeNull();
    });
  });

  describe('sourcesForTrack', () => {
    it('keeps the title and the artist of each source on a lip-sync mix', () => {
      expect(
        sourcesForTrack([{ ...SOURCE, extra: 'dropped' } as typeof SOURCE], {
          type: StudioReleaseType.LipSync,
          status: StudioReleaseStatus.Draft,
        }),
      ).toEqual([SOURCE]);
    });

    it('refuses sources on a type that has none', () => {
      expect(
        thrownBy(() =>
          sourcesForTrack([SOURCE], {
            type: StudioReleaseType.Album,
            status: StudioReleaseStatus.Draft,
          }),
        ),
      ).toBeInstanceOf(BadRequestException);
      expect(
        sourcesForTrack([], {
          type: StudioReleaseType.Album,
          status: StudioReleaseStatus.Published,
        }),
      ).toEqual([]);
    });

    it('lets a draft clear its sources and keeps a live or upcoming one credited', () => {
      expect(
        sourcesForTrack([], {
          type: StudioReleaseType.Edit,
          status: StudioReleaseStatus.Draft,
        }),
      ).toEqual([]);
      for (const status of [
        StudioReleaseStatus.Published,
        StudioReleaseStatus.Scheduled,
      ]) {
        expect(
          codeOf(() =>
            sourcesForTrack([], { type: StudioReleaseType.Mix, status }),
          ),
        ).toBe('studio_publish_missing_sources');
      }
    });
  });

  it('knows whether every track credits a source', () => {
    expect(hasEverySource([{ sources: [SOURCE] }, { sources: [SOURCE] }])).toBe(
      true,
    );
    expect(hasEverySource([{ sources: [SOURCE] }, { sources: [] }])).toBe(
      false,
    );
    expect(hasEverySource([])).toBe(true);
  });
});

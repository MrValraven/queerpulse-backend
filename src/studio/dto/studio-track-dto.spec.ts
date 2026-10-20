import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfirmStudioAudioDto } from './confirm-studio-audio.dto';
import { CreateStudioTrackDto } from './create-studio-track.dto';
import { ReorderStudioTracksDto } from './reorder-studio-tracks.dto';
import { UpdateStudioTrackDto } from './update-studio-track.dto';

const TRACK_ID = 'e1000000-0000-4000-8000-000000000001';
const PEAKS = Array.from({ length: 200 }, (_unused, index) => index);

async function errorsFor(
  dtoClass: new () => object,
  body: object,
): Promise<string[]> {
  return (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();
}

describe('Studio track bodies', () => {
  it('trims a track title and refuses a blank one', async () => {
    expect(
      plainToInstance(CreateStudioTrackDto, { title: '  Opening ' }).title,
    ).toBe('Opening');
    expect(await errorsFor(CreateStudioTrackDto, { title: '  ' })).toEqual([
      'title',
    ]);
  });

  it('trims credit names and roles and allows twenty rows', async () => {
    const body = plainToInstance(UpdateStudioTrackDto, {
      credits: [{ name: ' Ana ', role: ' Vocals ' }],
    });
    expect(body.credits).toEqual([{ name: 'Ana', role: 'Vocals' }]);
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        credits: Array.from({ length: 20 }, () => ({
          name: 'Ana',
          role: 'Vocals',
        })),
      }),
    ).toEqual([]);
  });

  it('refuses a 21st credit, a blank role and an 81-character name', async () => {
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        credits: Array.from({ length: 21 }, () => ({
          name: 'Ana',
          role: 'Vocals',
        })),
      }),
    ).toEqual(['credits']);
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        credits: [{ name: 'Ana', role: ' ' }],
      }),
    ).toEqual(['credits']);
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        credits: [{ name: 'x'.repeat(81), role: 'Vocals' }],
      }),
    ).toEqual(['credits']);
  });

  it('refuses null for the title, credits and explicit flag, and takes null lyrics', async () => {
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        title: null,
        credits: null,
        isExplicit: null,
      }),
    ).toEqual(['credits', 'isExplicit', 'title']);
    expect(await errorsFor(UpdateStudioTrackDto, { lyrics: null })).toEqual([]);
    expect(
      await errorsFor(UpdateStudioTrackDto, { lyrics: 'x'.repeat(10001) }),
    ).toEqual(['lyrics']);
  });

  it('takes between one and 500 track ids for an order', async () => {
    expect(await errorsFor(ReorderStudioTracksDto, { trackIds: [] })).toEqual([
      'trackIds',
    ]);
    expect(
      await errorsFor(ReorderStudioTracksDto, {
        trackIds: [TRACK_ID, 'track-2'],
      }),
    ).toEqual(['trackIds']);
    expect(
      await errorsFor(ReorderStudioTracksDto, { trackIds: [TRACK_ID] }),
    ).toEqual([]);
    expect(
      await errorsFor(ReorderStudioTracksDto, {
        trackIds: Array.from({ length: 500 }, () => TRACK_ID),
      }),
    ).toEqual([]);
    expect(
      await errorsFor(ReorderStudioTracksDto, {
        trackIds: Array.from({ length: 501 }, () => TRACK_ID),
      }),
    ).toEqual(['trackIds']);
  });

  it('takes a minted Studio audio key only', async () => {
    expect(
      await errorsFor(ConfirmStudioAudioDto, {
        key: 'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.m4a',
      }),
    ).toEqual([]);
    expect(
      await errorsFor(ConfirmStudioAudioDto, {
        key: 'avatars/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.jpg',
      }),
    ).toEqual(['key']);
  });

  describe('waveform peaks', () => {
    it('takes exactly 200 whole peaks from 0 to 255, and null to clear', async () => {
      expect(
        await errorsFor(UpdateStudioTrackDto, { waveformPeaks: PEAKS }),
      ).toEqual([]);
      expect(
        await errorsFor(UpdateStudioTrackDto, {
          waveformPeaks: Array.from({ length: 200 }, () => 255),
        }),
      ).toEqual([]);
      expect(
        await errorsFor(UpdateStudioTrackDto, { waveformPeaks: null }),
      ).toEqual([]);
    });

    it.each([
      ['199 peaks', PEAKS.slice(1)],
      ['201 peaks', [...PEAKS, 0]],
      ['a peak above 255', [...PEAKS.slice(1), 256]],
      ['a negative peak', [...PEAKS.slice(1), -1]],
      ['a fractional peak', [...PEAKS.slice(1), 1.5]],
      ['a peak sent as text', [...PEAKS.slice(1), '12']],
      ['a single number', 12],
    ])('refuses %s', async (_label, waveformPeaks) => {
      expect(await errorsFor(UpdateStudioTrackDto, { waveformPeaks })).toEqual([
        'waveformPeaks',
      ]);
    });
  });

  describe('loudness pair', () => {
    it('rounds both values to one decimal before the range check', async () => {
      const body = plainToInstance(UpdateStudioTrackDto, {
        loudnessLufs: -7.84,
        peakDb: -0.06,
      });
      expect(body.loudnessLufs).toBe(-7.8);
      expect(body.peakDb).toBe(-0.1);
      expect(
        await errorsFor(UpdateStudioTrackDto, {
          loudnessLufs: -70.04,
          peakDb: 3.04,
        }),
      ).toEqual([]);
      expect(
        await errorsFor(UpdateStudioTrackDto, {
          loudnessLufs: -70.06,
          peakDb: 3.06,
        }),
      ).toEqual(['loudnessLufs', 'peakDb']);
    });

    it('takes the pair together, as two values or two nulls', async () => {
      expect(
        await errorsFor(UpdateStudioTrackDto, {
          loudnessLufs: -14,
          peakDb: -1,
        }),
      ).toEqual([]);
      expect(
        await errorsFor(UpdateStudioTrackDto, {
          loudnessLufs: null,
          peakDb: null,
        }),
      ).toEqual([]);
    });

    it.each([
      ['a loudness alone', { loudnessLufs: -14 }, ['loudnessLufs']],
      ['a peak alone', { peakDb: -1 }, ['peakDb']],
      ['a null loudness alone', { loudnessLufs: null }, ['loudnessLufs']],
      ['a null peak alone', { peakDb: null }, ['peakDb']],
      [
        'a loudness with a null peak',
        { loudnessLufs: -14, peakDb: null },
        ['loudnessLufs', 'peakDb'],
      ],
    ])('refuses %s', async (_label, body, expectedProperties) => {
      expect(await errorsFor(UpdateStudioTrackDto, body)).toEqual(
        expectedProperties,
      );
    });

    it('holds loudness to -70.0..0.0 and the peak to -60.0..3.0', async () => {
      expect(
        await errorsFor(UpdateStudioTrackDto, { loudnessLufs: -70, peakDb: 3 }),
      ).toEqual([]);
      expect(
        await errorsFor(UpdateStudioTrackDto, { loudnessLufs: 0, peakDb: -60 }),
      ).toEqual([]);
      expect(
        await errorsFor(UpdateStudioTrackDto, {
          loudnessLufs: 0.1,
          peakDb: 3.1,
        }),
      ).toEqual(['loudnessLufs', 'peakDb']);
      expect(
        await errorsFor(UpdateStudioTrackDto, {
          loudnessLufs: -70.1,
          peakDb: -60.1,
        }),
      ).toEqual(['loudnessLufs', 'peakDb']);
      expect(
        await errorsFor(UpdateStudioTrackDto, {
          loudnessLufs: '-14',
          peakDb: -1,
        }),
      ).toEqual(['loudnessLufs']);
    });
  });

  describe('timed lyrics', () => {
    it('trims each line, keeps empty gaps and takes equal times', async () => {
      const lines = [
        { ms: 0, text: '  First line ' },
        { ms: 0, text: 'Same moment' },
        { ms: 4000, text: '   ' },
      ];
      expect(
        plainToInstance(UpdateStudioTrackDto, { syncedLyrics: lines })
          .syncedLyrics,
      ).toEqual([
        { ms: 0, text: 'First line' },
        { ms: 0, text: 'Same moment' },
        { ms: 4000, text: '' },
      ]);
      expect(
        await errorsFor(UpdateStudioTrackDto, { syncedLyrics: lines }),
      ).toEqual([]);
    });

    it('takes 500 lines up to 24 hours in, and null to clear', async () => {
      expect(
        await errorsFor(UpdateStudioTrackDto, {
          syncedLyrics: Array.from({ length: 500 }, (_unused, index) => ({
            ms: index * 1000,
            text: 'la',
          })),
        }),
      ).toEqual([]);
      expect(
        await errorsFor(UpdateStudioTrackDto, {
          syncedLyrics: [{ ms: 86400000, text: 'Last line' }],
        }),
      ).toEqual([]);
      expect(
        await errorsFor(UpdateStudioTrackDto, { syncedLyrics: null }),
      ).toEqual([]);
    });

    it.each([
      ['an empty list', []],
      [
        '501 lines',
        Array.from({ length: 501 }, (_unused, index) => ({
          ms: index * 1000,
          text: 'la',
        })),
      ],
      [
        'a line earlier than the one before it',
        [
          { ms: 5000, text: 'Second' },
          { ms: 4000, text: 'First' },
        ],
      ],
      ['a fractional time', [{ ms: 1.5, text: 'First' }]],
      ['a negative time', [{ ms: -1, text: 'First' }]],
      ['a time past 24 hours', [{ ms: 86400001, text: 'First' }]],
      ['a 301-character line', [{ ms: 0, text: 'x'.repeat(301) }]],
      ['a line with no text', [{ ms: 0 }]],
      ['a line that is plain text', ['First line']],
    ])('refuses timed lyrics with %s', async (_label, syncedLyrics) => {
      expect(await errorsFor(UpdateStudioTrackDto, { syncedLyrics })).toEqual([
        'syncedLyrics',
      ]);
    });
  });

  describe('chapters', () => {
    it('trims titles and artists and takes an absent or blank artist', async () => {
      const chapters = [
        { startSeconds: 0, title: ' Intro ' },
        { startSeconds: 95, title: 'Second', artist: '  ' },
        { startSeconds: 200, title: 'Third', artist: ' Ana Moura ' },
        { startSeconds: 310, title: 'Fourth', artist: null },
      ];
      expect(
        plainToInstance(UpdateStudioTrackDto, { chapters }).chapters,
      ).toEqual([
        { startSeconds: 0, title: 'Intro' },
        { startSeconds: 95, title: 'Second', artist: '' },
        { startSeconds: 200, title: 'Third', artist: 'Ana Moura' },
        { startSeconds: 310, title: 'Fourth', artist: null },
      ]);
      expect(await errorsFor(UpdateStudioTrackDto, { chapters })).toEqual([]);
    });

    it('takes 100 chapters, and null to clear', async () => {
      expect(
        await errorsFor(UpdateStudioTrackDto, {
          chapters: Array.from({ length: 100 }, (_unused, index) => ({
            startSeconds: index * 10,
            title: `Part ${index + 1}`,
          })),
        }),
      ).toEqual([]);
      expect(await errorsFor(UpdateStudioTrackDto, { chapters: null })).toEqual(
        [],
      );
    });

    it.each([
      ['an empty list', []],
      [
        '101 chapters',
        Array.from({ length: 101 }, (_unused, index) => ({
          startSeconds: index * 10,
          title: `Part ${index + 1}`,
        })),
      ],
      ['a first chapter after zero', [{ startSeconds: 5, title: 'Intro' }]],
      [
        'two chapters at one time',
        [
          { startSeconds: 0, title: 'Intro' },
          { startSeconds: 0, title: 'Again' },
        ],
      ],
      [
        'chapters out of order',
        [
          { startSeconds: 0, title: 'Intro' },
          { startSeconds: 300, title: 'Third' },
          { startSeconds: 200, title: 'Second' },
        ],
      ],
      [
        'a fractional start',
        [
          { startSeconds: 0, title: 'Intro' },
          { startSeconds: 1.5, title: 'Second' },
        ],
      ],
      ['a blank title', [{ startSeconds: 0, title: '   ' }]],
      ['a 121-character title', [{ startSeconds: 0, title: 'x'.repeat(121) }]],
      [
        'a 121-character artist',
        [{ startSeconds: 0, title: 'Intro', artist: 'x'.repeat(121) }],
      ],
      ['a chapter with no start', [{ title: 'Intro' }]],
    ])('refuses chapters with %s', async (_label, chapters) => {
      expect(await errorsFor(UpdateStudioTrackDto, { chapters })).toEqual([
        'chapters',
      ]);
    });
  });

  // Studio artist kinds.
  it('takes a transcript of up to 60000 characters and leaves the format cap to the service', async () => {
    expect(
      await errorsFor(UpdateStudioTrackDto, { lyrics: 't'.repeat(60000) }),
    ).toEqual([]);
    expect(
      await errorsFor(UpdateStudioTrackDto, { lyrics: 't'.repeat(60001) }),
    ).toEqual(['lyrics']);
  });

  it('takes show notes up to 4000 characters and null', async () => {
    expect(
      await errorsFor(UpdateStudioTrackDto, { notes: 'n'.repeat(4000) }),
    ).toEqual([]);
    expect(await errorsFor(UpdateStudioTrackDto, { notes: null })).toEqual([]);
    expect(
      await errorsFor(UpdateStudioTrackDto, { notes: 'n'.repeat(4001) }),
    ).toEqual(['notes']);
    expect(await errorsFor(UpdateStudioTrackDto, { notes: 42 })).toEqual([
      'notes',
    ]);
  });

  it('trims each source and takes an empty list', async () => {
    const body = plainToInstance(UpdateStudioTrackDto, {
      sources: [{ title: '  Rumour Has It ', artist: ' Adele ' }],
    });
    expect(body.sources).toEqual([{ title: 'Rumour Has It', artist: 'Adele' }]);
    expect(await errorsFor(UpdateStudioTrackDto, { sources: [] })).toEqual([]);
  });

  it.each([
    ['null', null],
    ['a blank title', [{ title: '   ', artist: 'Adele' }]],
    ['a missing artist', [{ title: 'Rumour Has It' }]],
    ['a 121 character title', [{ title: 's'.repeat(121), artist: 'Adele' }]],
    [
      '101 sources',
      Array.from({ length: 101 }, (_unused, index) => ({
        title: `Song ${index}`,
        artist: 'Adele',
      })),
    ],
  ])('refuses sources with %s', async (_label, sources) => {
    expect(await errorsFor(UpdateStudioTrackDto, { sources })).toEqual([
      'sources',
    ]);
  });

  // Studio safety and moderation.
  it('takes known content warning ids, an empty list and up to eight', async () => {
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        contentWarnings: ['medical', 'police'],
      }),
    ).toEqual([]);
    expect(
      await errorsFor(UpdateStudioTrackDto, { contentWarnings: [] }),
    ).toEqual([]);
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        contentWarnings: [
          'medical',
          'violence',
          'substances',
          'family-rejection',
          'sexual-content',
          'self-harm',
          'housing-loss',
          'police',
        ],
      }),
    ).toEqual([]);
  });

  it('refuses an unknown warning id, null, a string and a ninth entry', async () => {
    for (const contentWarnings of [
      ['gore'],
      null,
      'police',
      [
        'medical',
        'violence',
        'substances',
        'family-rejection',
        'sexual-content',
        'self-harm',
        'housing-loss',
        'police',
        'police',
      ],
    ]) {
      expect(
        await errorsFor(UpdateStudioTrackDto, { contentWarnings }),
      ).toEqual(['contentWarnings']);
    }
  });
});

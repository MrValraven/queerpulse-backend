import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { StorageService } from '../storage/storage.service';
import {
  invalidateStudioLandingMemo,
  resetStudioLandingMemoForTesting,
} from './studio-landing-memo';
import {
  LANDING_ARTIST_CARDS_SQL,
  LANDING_COUNTS_SQL,
  LANDING_NEXT_EVENT_SQL,
  LANDING_PHOTOS_SQL,
  LANDING_PREVIEWS_SQL,
  LANDING_PREVIEW_STREAM_SQL,
  StudioLandingReadService,
} from './studio-landing-read.service';

const API_BASE = 'https://api.example.test';
const PREVIEW_ID = 'e7000000-0000-4000-8000-000000000001';
const CARD_ID = 'e7000000-0000-4000-8000-000000000002';
const AUDIO_KEY =
  'studio-audio/e7100000-0000-4000-8000-000000000001/e7100000-0000-4000-8000-000000000002.mp3';
const HERO_KEY =
  'studio-landing/e7200000-0000-4000-8000-000000000001/e7200000-0000-4000-8000-000000000002.jpg';
const SIGNED_URL = 'https://bucket.example.test/signed-preview';
const EXPIRES_AT = '2026-10-28T10:15:00.000Z';

const PERSONA_COLUMNS = {
  artist_handle: 'river-ink',
  artist_display_name: 'River Ink',
  artist_kind: 'musician',
  artist_avatar_url: 'https://images.example.test/river.jpg',
  artist_link_visibility: 'linked',
};

const PERSONA = {
  name: 'River Ink',
  handle: 'river-ink',
  kind: 'musician',
  avatarUrl: 'https://images.example.test/river.jpg',
};

function rowsFor(sql: string): unknown[] {
  switch (sql) {
    case LANDING_COUNTS_SQL:
      return [{ artists: 4, releases: 12, events_this_month: 5 }];
    case LANDING_NEXT_EVENT_SQL:
      return [
        {
          slug: 'night-market',
          title: 'Night market',
          start_at: new Date('2026-11-02T21:00:00.000Z'),
          timezone: 'Europe/Lisbon',
          neighbourhood: 'Intendente',
          is_online: false,
          ...PERSONA_COLUMNS,
        },
      ];
    case LANDING_PREVIEWS_SQL:
      return [
        {
          id: PREVIEW_ID,
          track_title: 'Opening',
          duration_seconds: 210,
          cover_key: null,
          ...PERSONA_COLUMNS,
        },
      ];
    case LANDING_ARTIST_CARDS_SQL:
      return [
        {
          id: CARD_ID,
          quote: 'We play loud',
          is_founding_artist: true,
          ...PERSONA_COLUMNS,
        },
      ];
    case LANDING_PHOTOS_SQL:
      return [
        {
          slot: 'hero',
          image_key: HERO_KEY,
          alt_text_en: 'A crowd dancing',
          alt_text_pt: 'Uma multidão a dançar',
          credit: 'Ana Lima',
        },
      ];
    default:
      return [];
  }
}

describe('StudioLandingReadService', () => {
  let query: jest.Mock;
  let storage: { createPresignedAudioStream: jest.Mock };
  let service: StudioLandingReadService;

  beforeAll(() => {
    setImageUrlBase(API_BASE);
  });

  afterAll(() => {
    resetImageUrlBaseForTesting();
  });

  beforeEach(() => {
    resetStudioLandingMemoForTesting();
    query = jest.fn((sql: string) => Promise.resolve(rowsFor(sql)));
    storage = {
      createPresignedAudioStream: jest
        .fn()
        .mockResolvedValue({ url: SIGNED_URL, expiresAt: EXPIRES_AT }),
    };
    service = new StudioLandingReadService(
      { query } as unknown as DataSource,
      storage as unknown as StorageService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('public landing SQL', () => {
    it('heads every public landing read with the private-parameters marker', () => {
      const landingReads = [
        LANDING_COUNTS_SQL,
        LANDING_NEXT_EVENT_SQL,
        LANDING_PREVIEWS_SQL,
        LANDING_ARTIST_CARDS_SQL,
        LANDING_PHOTOS_SQL,
        LANDING_PREVIEW_STREAM_SQL,
      ];

      expect(
        landingReads.map((sql) => sql.startsWith('/* private-parameters */')),
      ).toEqual([true, true, true, true, true, true]);
    });

    it('keeps the next event to a linked persona', () => {
      expect(LANDING_NEXT_EVENT_SQL).toContain(
        `"persona"."link_visibility" = 'linked'`,
      );
    });
  });

  describe('getPublicLanding', () => {
    it('builds the payload from five reads and floors the counts', async () => {
      const landing = await service.getPublicLanding();

      expect(landing.counts).toEqual({
        artists: null,
        releases: 12,
        eventsThisMonth: 5,
      });
      expect(query).toHaveBeenCalledTimes(5);
      expect(query).toHaveBeenCalledWith(LANDING_COUNTS_SQL, ['Europe/Lisbon']);
      expect(query).toHaveBeenCalledWith(LANDING_NEXT_EVENT_SQL);
      expect(query).toHaveBeenCalledWith(LANDING_PREVIEWS_SQL, [5]);
      expect(query).toHaveBeenCalledWith(LANDING_ARTIST_CARDS_SQL, [6]);
      expect(query).toHaveBeenCalledWith(LANDING_PHOTOS_SQL);
    });

    it('maps every section to the contract shapes', async () => {
      expect(await service.getPublicLanding()).toEqual({
        counts: { artists: null, releases: 12, eventsThisMonth: 5 },
        nextEvent: {
          slug: 'night-market',
          title: 'Night market',
          startAt: '2026-11-02T21:00:00.000Z',
          timezone: 'Europe/Lisbon',
          area: 'Intendente',
          isOnline: false,
          artist: PERSONA,
        },
        previews: [
          {
            id: PREVIEW_ID,
            trackTitle: 'Opening',
            durationSeconds: 210,
            coverUrl: null,
            artist: PERSONA,
          },
        ],
        artists: [
          {
            id: CARD_ID,
            artist: PERSONA,
            quote: 'We play loud',
            isFoundingArtist: true,
          },
        ],
        photos: {
          hero: {
            url: `${API_BASE}/files/${HERO_KEY}`,
            altText: { en: 'A crowd dancing', pt: 'Uma multidão a dançar' },
            credit: 'Ana Lima',
          },
          manifesto: null,
        },
      });
    });

    it('reads null for the next event and empty lists when nothing qualifies', async () => {
      query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql === LANDING_COUNTS_SQL
            ? [{ artists: 0, releases: 0, events_this_month: 0 }]
            : [],
        ),
      );

      expect(await service.getPublicLanding()).toEqual({
        counts: { artists: null, releases: null, eventsThisMonth: null },
        nextEvent: null,
        previews: [],
        artists: [],
        photos: { hero: null, manifesto: null },
      });
    });

    it('memoises the payload for 60 seconds and rebuilds after', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-28T10:00:00.000Z'));
      await service.getPublicLanding();
      await service.getPublicLanding();
      expect(query).toHaveBeenCalledTimes(5);

      jest.setSystemTime(new Date('2026-10-28T10:00:59.999Z'));
      await service.getPublicLanding();
      expect(query).toHaveBeenCalledTimes(5);

      jest.setSystemTime(new Date('2026-10-28T10:01:00.001Z'));
      await service.getPublicLanding();
      expect(query).toHaveBeenCalledTimes(10);
    });

    it('rebuilds at once after an invalidate', async () => {
      await service.getPublicLanding();
      service.invalidate();
      await service.getPublicLanding();

      expect(query).toHaveBeenCalledTimes(10);
    });

    it('rebuilds at once after a writer bumps the memo generation', async () => {
      await service.getPublicLanding();
      invalidateStudioLandingMemo();
      await service.getPublicLanding();

      expect(query).toHaveBeenCalledTimes(10);
    });

    it('keeps a build that started before an invalidate out of the memo', async () => {
      let hasInvalidated = false;
      query.mockImplementation((sql: string) => {
        if (!hasInvalidated) {
          hasInvalidated = true;
          invalidateStudioLandingMemo();
        }
        return Promise.resolve(rowsFor(sql));
      });

      await service.getPublicLanding();
      await service.getPublicLanding();
      expect(query).toHaveBeenCalledTimes(10);

      await service.getPublicLanding();
      expect(query).toHaveBeenCalledTimes(10);
    });
  });

  describe('getPreviewStream', () => {
    it('answers the stream of an approved eligible preview with its url and expiry', async () => {
      query.mockResolvedValueOnce([
        {
          audio_key: AUDIO_KEY,
          audio_content_type: 'audio/mpeg',
          duration_seconds: 210,
        },
      ]);

      expect(await service.getPreviewStream(PREVIEW_ID)).toEqual({
        url: SIGNED_URL,
        expiresAt: EXPIRES_AT,
      });
      expect(query).toHaveBeenCalledWith(LANDING_PREVIEW_STREAM_SQL, [
        PREVIEW_ID,
      ]);
      expect(storage.createPresignedAudioStream).toHaveBeenCalledWith(
        AUDIO_KEY,
        'audio/mpeg',
        210,
      );
    });

    it('reads the content type from the key when the row stores none', async () => {
      query.mockResolvedValueOnce([
        {
          audio_key: AUDIO_KEY,
          audio_content_type: null,
          duration_seconds: 210,
        },
      ]);

      await service.getPreviewStream(PREVIEW_ID);

      expect(storage.createPresignedAudioStream).toHaveBeenCalledWith(
        AUDIO_KEY,
        'audio/mpeg',
        210,
      );
    });

    it('answers studio_landing_preview_unavailable for a missing row', async () => {
      query.mockResolvedValueOnce([]);

      await expect(service.getPreviewStream(PREVIEW_ID)).rejects.toMatchObject({
        status: 404,
        response: {
          statusCode: 404,
          code: 'studio_landing_preview_unavailable',
          message: 'This preview is not available.',
        },
      });
      expect(storage.createPresignedAudioStream).not.toHaveBeenCalled();
    });

    it('answers studio_landing_preview_unavailable for an audio key outside Studio audio', async () => {
      query.mockResolvedValueOnce([
        {
          audio_key: HERO_KEY,
          audio_content_type: 'audio/mpeg',
          duration_seconds: 210,
        },
      ]);

      await expect(service.getPreviewStream(PREVIEW_ID)).rejects.toMatchObject({
        status: 404,
        response: { code: 'studio_landing_preview_unavailable' },
      });
      expect(storage.createPresignedAudioStream).not.toHaveBeenCalled();
    });

    it('answers studio_landing_preview_unavailable for a malformed id without a read', async () => {
      await expect(
        service.getPreviewStream('not-a-uuid'),
      ).rejects.toMatchObject({
        response: { code: 'studio_landing_preview_unavailable' },
      });
      expect(query).not.toHaveBeenCalled();
    });

    it('records nothing when it streams', async () => {
      const logSpies = (
        ['log', 'warn', 'error', 'debug', 'verbose'] as const
      ).map((method) => jest.spyOn(Logger.prototype, method));
      const staticLogSpies = (
        ['log', 'warn', 'error', 'debug', 'verbose'] as const
      ).map((method) => jest.spyOn(Logger, method));
      query.mockResolvedValueOnce([
        {
          audio_key: AUDIO_KEY,
          audio_content_type: 'audio/mpeg',
          duration_seconds: 210,
        },
      ]);

      await service.getPreviewStream(PREVIEW_ID);

      const everySql = query.mock.calls.map(([sql]: [string]) => sql).join(' ');
      expect(everySql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
      for (const logSpy of [...logSpies, ...staticLogSpies]) {
        expect(logSpy).not.toHaveBeenCalled();
      }
    });
  });
});

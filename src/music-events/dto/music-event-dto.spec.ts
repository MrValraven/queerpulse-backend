import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { MAX_PAGE } from '../../common/pagination';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { CreateMusicEventDto } from './create-music-event.dto';
import { ListMusicEventsQuery } from './list-music-events.query';
import { StudioArtistSearchQuery } from './studio-artist-search.query';
import { UpdateMusicEventDto } from './update-music-event.dto';

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const validBody = {
  title: 'Friday night live',
  description: 'Three acts and a late set.',
  startAt: '2026-11-20T21:00:00.000Z',
  timezone: 'Europe/Lisbon',
};

const bodyMetadata = (metatype: ArgumentMetadata['metatype']) => ({
  type: 'body' as const,
  metatype,
});
const queryMetadata = (metatype: ArgumentMetadata['metatype']) => ({
  type: 'query' as const,
  metatype,
});

async function refusedProperties(
  value: unknown,
  metadata: ArgumentMetadata,
): Promise<string[]> {
  try {
    await pipe.transform(value, metadata);
    return [];
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    const response = error.getResponse() as { message: string[] };
    return response.message;
  }
}

describe('music event DTOs', () => {
  it('accepts a full wizard body with gatheringFamily music', async () => {
    const body = {
      ...validBody,
      endAt: '2026-11-21T01:00:00.000Z',
      venue: 'The house floor',
      isOnline: false,
      capacity: 120,
      gatheringFamily: 'music',
      eventType: 'live-performance',
      cost: '10 EUR',
      costKind: 'fixed',
      themes: [],
      contentNotes: [],
      recurrence: { cadence: 'weekly', endType: 'count', endCount: 2 },
    };
    const result = await pipe.transform(
      body,
      bodyMetadata(CreateMusicEventDto),
    );
    expect(result).toBeInstanceOf(CreateMusicEventDto);
    expect(result).toMatchObject({ gatheringFamily: 'music', capacity: 120 });
  });

  it('refuses communitySlug and runByListingId on create and update', async () => {
    const extraFields = {
      communitySlug: 'some-community',
      runByListingId: '3f1c1b1e-6a6e-4d7c-9a8e-0a1b2c3d4e5f',
    };
    const createRefusals = await refusedProperties(
      { ...validBody, ...extraFields },
      bodyMetadata(CreateMusicEventDto),
    );
    const updateRefusals = await refusedProperties(
      extraFields,
      bodyMetadata(UpdateMusicEventDto),
    );
    for (const refusals of [createRefusals, updateRefusals]) {
      expect(refusals).toEqual(
        expect.arrayContaining([
          'property communitySlug should not exist',
          'property runByListingId should not exist',
        ]),
      );
    }
  });

  it('refuses recurrence on update', async () => {
    const refusals = await refusedProperties(
      { recurrence: { cadence: 'weekly', endType: 'count', endCount: 2 } },
      bodyMetadata(UpdateMusicEventDto),
    );
    expect(refusals).toEqual(['property recurrence should not exist']);
  });

  it('refuses an unknown bucket and a page past MAX_PAGE', async () => {
    const unknownBucket = await refusedProperties(
      { bucket: 'archived' },
      queryMetadata(ListMusicEventsQuery),
    );
    const pageTooDeep = await refusedProperties(
      { page: String(MAX_PAGE + 1) },
      queryMetadata(ListMusicEventsQuery),
    );
    const validQuery = await pipe.transform(
      { bucket: 'cancelled', page: String(MAX_PAGE) },
      queryMetadata(ListMusicEventsQuery),
    );
    expect(unknownBucket).toHaveLength(1);
    expect(unknownBucket[0]).toContain('bucket');
    expect(pageTooDeep).toHaveLength(1);
    expect(pageTooDeep[0]).toContain('page');
    expect(validQuery).toMatchObject({ bucket: 'cancelled', page: MAX_PAGE });
  });

  it('trims q and refuses one longer than 100', async () => {
    const trimmed = await pipe.transform(
      { q: '  Mira  ', page: '2' },
      queryMetadata(StudioArtistSearchQuery),
    );
    const atLimit = await refusedProperties(
      { q: 'a'.repeat(100) },
      queryMetadata(StudioArtistSearchQuery),
    );
    const overLimit = await refusedProperties(
      { q: 'a'.repeat(101) },
      queryMetadata(StudioArtistSearchQuery),
    );
    expect(trimmed).toMatchObject({ q: 'Mira', page: 2 });
    expect(atLimit).toEqual([]);
    expect(overLimit).toHaveLength(1);
    expect(overLimit[0]).toContain('q');
  });
});

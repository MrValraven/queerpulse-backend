import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateStudioReleaseDto } from './create-studio-release.dto';
import { UpdateStudioReleaseDto } from './update-studio-release.dto';

const PERSONA_ID = 'a1000000-0000-4000-8000-000000000001';

const errorsFor = async <BodyClass extends object>(
  dtoClass: ClassConstructor<BodyClass>,
  body: object,
): Promise<string[]> =>
  (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();

describe('Studio release bodies', () => {
  it('trims a title and refuses a blank one on create', async () => {
    const trimmed = plainToInstance(CreateStudioReleaseDto, {
      subprofileId: PERSONA_ID,
      type: 'mix',
      title: '  Lisbon at four  ',
    });
    expect(trimmed.title).toBe('Lisbon at four');
    expect(
      await errorsFor(CreateStudioReleaseDto, {
        subprofileId: PERSONA_ID,
        type: 'mix',
        title: '   ',
      }),
    ).toEqual(['title']);
  });

  it('refuses a title of 121 characters and an unknown type', async () => {
    expect(
      await errorsFor(CreateStudioReleaseDto, {
        subprofileId: PERSONA_ID,
        type: 'mixtape',
        title: 'x'.repeat(121),
      }),
    ).toEqual(['title', 'type']);
  });

  it('refuses null for the title and the type on an edit', async () => {
    expect(await errorsFor(UpdateStudioReleaseDto, { title: null })).toEqual([
      'title',
    ]);
    expect(await errorsFor(UpdateStudioReleaseDto, { type: null })).toEqual([
      'type',
    ]);
  });

  it('accepts null to clear the description, release date and cover, and an empty list to clear the genres', async () => {
    expect(
      await errorsFor(UpdateStudioReleaseDto, {
        description: null,
        genres: [],
        releasedOn: null,
        coverKey: null,
      }),
    ).toEqual([]);
  });

  it('accepts a real calendar date only', async () => {
    expect(
      await errorsFor(UpdateStudioReleaseDto, { releasedOn: '2026-10-08' }),
    ).toEqual([]);
    expect(
      await errorsFor(UpdateStudioReleaseDto, { releasedOn: '2026-02-30' }),
    ).toEqual(['releasedOn']);
    expect(
      await errorsFor(UpdateStudioReleaseDto, {
        releasedOn: '2026-10-08T00:00:00Z',
      }),
    ).toEqual(['releasedOn']);
  });

  it('takes rightsConfirmed as true only', async () => {
    expect(
      await errorsFor(UpdateStudioReleaseDto, { rightsConfirmed: true }),
    ).toEqual([]);
    expect(
      await errorsFor(UpdateStudioReleaseDto, { rightsConfirmed: false }),
    ).toEqual(['rightsConfirmed']);
  });

  it('takes a description of at most 2000 characters', async () => {
    expect(
      await errorsFor(UpdateStudioReleaseDto, {
        description: 'x'.repeat(2001),
      }),
    ).toEqual(['description']);
  });

  it('takes up to five listed genres, each picked once', async () => {
    expect(
      await errorsFor(UpdateStudioReleaseDto, {
        genres: ['fado', 'folk', 'pop', 'house', 'ambient'],
      }),
    ).toEqual([]);
    expect(
      await errorsFor(UpdateStudioReleaseDto, { genres: ['polka'] }),
    ).toEqual(['genres']);
    expect(
      await errorsFor(UpdateStudioReleaseDto, {
        genres: ['fado', 'folk', 'pop', 'house', 'ambient', 'jazz'],
      }),
    ).toEqual(['genres']);
    expect(
      await errorsFor(UpdateStudioReleaseDto, { genres: ['fado', 'fado'] }),
    ).toEqual(['genres']);
    expect(await errorsFor(UpdateStudioReleaseDto, { genres: null })).toEqual([
      'genres',
    ]);
    expect(await errorsFor(UpdateStudioReleaseDto, { genres: 'fado' })).toEqual(
      ['genres'],
    );
  });

  it('refuses the removed single genre field', async () => {
    const dto = plainToInstance(UpdateStudioReleaseDto, { genre: 'fado' });
    expect(dto).not.toHaveProperty('genres');
    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).toHaveLength(1);
  });

  it('names the cause when the genres are too many or repeated', async () => {
    const messagesOf = async (genres: string[]): Promise<string[]> =>
      (await validate(plainToInstance(UpdateStudioReleaseDto, { genres })))
        .flatMap((error) => Object.values(error.constraints ?? {}))
        .sort();
    expect(
      await messagesOf(['fado', 'folk', 'pop', 'house', 'ambient', 'jazz']),
    ).toEqual(['A release can carry up to 5 genres']);
    expect(await messagesOf(['fado', 'fado'])).toEqual([
      'Each genre can be picked once',
    ]);
  });

  it('takes a mood from the list and null to clear it', async () => {
    expect(
      await errorsFor(UpdateStudioReleaseDto, { mood: 'slow-burn' }),
    ).toEqual([]);
    expect(await errorsFor(UpdateStudioReleaseDto, { mood: null })).toEqual([]);
    expect(await errorsFor(UpdateStudioReleaseDto, { mood: 'gloomy' })).toEqual(
      ['mood'],
    );
  });

  it('takes a scene id or null to leave the scene', async () => {
    expect(
      await errorsFor(UpdateStudioReleaseDto, {
        sceneId: 'e1000000-0000-4000-8000-000000000001',
      }),
    ).toEqual([]);
    expect(await errorsFor(UpdateStudioReleaseDto, { sceneId: null })).toEqual(
      [],
    );
    expect(
      await errorsFor(UpdateStudioReleaseDto, { sceneId: 'lisbon-ballroom' }),
    ).toEqual(['sceneId']);
  });

  // Studio v3: an outbound shop link, https only.
  it('accepts an https buy link and null, and refuses anything else', async () => {
    expect(
      await errorsFor(UpdateStudioReleaseDto, {
        buyUrl: 'https://nightshift.bandcamp.com/album/lisbon',
      }),
    ).toEqual([]);
    expect(await errorsFor(UpdateStudioReleaseDto, { buyUrl: null })).toEqual(
      [],
    );
    for (const buyUrl of [
      'http://nightshift.bandcamp.com',
      'mailto:shop@nightshift.test',
      'javascript:alert(1)',
      'nightshift.bandcamp.com',
      '',
      `https://shop.test/${'x'.repeat(1000)}`,
    ]) {
      expect(await errorsFor(UpdateStudioReleaseDto, { buyUrl })).toEqual([
        'buyUrl',
      ]);
    }
  });

  // Studio listening: "Play without gaps" is a plain switch.
  it('accepts true and false for isGapless and refuses null and a string', async () => {
    for (const isGapless of [true, false]) {
      expect(await errorsFor(UpdateStudioReleaseDto, { isGapless })).toEqual(
        [],
      );
    }
    for (const isGapless of [null, 'yes']) {
      expect(await errorsFor(UpdateStudioReleaseDto, { isGapless })).toEqual([
        'isGapless',
      ]);
    }
  });
});

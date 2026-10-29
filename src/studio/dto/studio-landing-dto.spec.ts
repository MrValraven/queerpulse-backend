import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateStudioFoundingArtistDto,
  CreateStudioLandingArtistCardDto,
  CreateStudioLandingPreviewDto,
  PutStudioLandingPhotoDto,
  ReorderStudioFoundingArtistsDto,
  ReorderStudioLandingArtistCardsDto,
  ReorderStudioLandingPreviewsDto,
  StudioLandingPhotoSlotParams,
  UpdateStudioLandingArtistCardDto,
  UpdateStudioLandingSettingsDto,
} from './admin-studio-landing.dto';
import {
  AdminStudioAccessRequestsQuery,
  CreateStudioAccessRequestDto,
} from './studio-access-request.dto';

const TRACK_ID = '3f0f6c0e-5d5b-4f0e-9a52-6c1f2f0b7a11';
const PERSONA_ID = '8a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d';
const PHOTO_URL =
  'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4';

const failingFields = async (
  dtoClass: new () => object,
  body: Record<string, unknown>,
): Promise<string[]> =>
  (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();

const uuidList = (count: number): string[] =>
  Array.from(
    { length: count },
    (_unused, index) =>
      `8a1d2c3e-4b5f-4a6b-8c7d-${String(index).padStart(12, '0')}`,
  );

const validPhotoBody = {
  imageKey: PHOTO_URL,
  altTextEn: 'A crowd at a night show',
  altTextPt: 'Um publico num concerto noturno',
  hasConsent: true,
};

describe('Studio landing request DTOs', () => {
  it('needs a uuid track for a preview request', async () => {
    expect(
      await failingFields(CreateStudioLandingPreviewDto, {
        trackId: TRACK_ID,
      }),
    ).toEqual([]);
    expect(await failingFields(CreateStudioLandingPreviewDto, {})).toEqual([
      'trackId',
    ]);
    expect(
      await failingFields(CreateStudioLandingPreviewDto, {
        trackId: 'night-bus',
      }),
    ).toEqual(['trackId']);
  });

  it('accepts a quote up to 240 characters, trims it and refuses 241', async () => {
    expect(
      await failingFields(CreateStudioLandingArtistCardDto, {
        subprofileId: PERSONA_ID,
        quote: `  ${'a'.repeat(240)}  `,
        hasConsent: true,
      }),
    ).toEqual([]);
    expect(
      await failingFields(CreateStudioLandingArtistCardDto, {
        subprofileId: PERSONA_ID,
        quote: 'a'.repeat(241),
        hasConsent: true,
      }),
    ).toEqual(['quote']);
    expect(
      await failingFields(CreateStudioLandingArtistCardDto, {
        subprofileId: PERSONA_ID,
        hasConsent: true,
      }),
    ).toEqual([]);
  });

  it('lets consent through as false so the service names the refusal', async () => {
    expect(
      await failingFields(CreateStudioLandingArtistCardDto, {
        subprofileId: PERSONA_ID,
        hasConsent: false,
      }),
    ).toEqual([]);
    expect(
      await failingFields(CreateStudioLandingArtistCardDto, {
        subprofileId: PERSONA_ID,
      }),
    ).toEqual(['hasConsent']);
    expect(
      await failingFields(CreateStudioLandingArtistCardDto, {
        subprofileId: PERSONA_ID,
        hasConsent: 'yes',
      }),
    ).toEqual(['hasConsent']);
  });

  it('needs the quote key on update, a string or null', async () => {
    expect(
      await failingFields(UpdateStudioLandingArtistCardDto, {
        hasConsent: true,
      }),
    ).toEqual(['quote']);
    expect(
      await failingFields(UpdateStudioLandingArtistCardDto, {
        quote: null,
        hasConsent: true,
      }),
    ).toEqual([]);
    expect(
      await failingFields(UpdateStudioLandingArtistCardDto, {
        quote: 'Loud and kind',
        hasConsent: false,
      }),
    ).toEqual([]);
    expect(
      await failingFields(UpdateStudioLandingArtistCardDto, {
        quote: 'a'.repeat(241),
        hasConsent: true,
      }),
    ).toEqual(['quote']);
    expect(
      await failingFields(UpdateStudioLandingArtistCardDto, { quote: null }),
    ).toEqual(['hasConsent']);
  });

  it('needs both alt texts of 1 to 200 characters and an image reference for a photo', async () => {
    expect(
      await failingFields(PutStudioLandingPhotoDto, validPhotoBody),
    ).toEqual([]);
    expect(
      await failingFields(PutStudioLandingPhotoDto, {
        ...validPhotoBody,
        altTextEn: 'a'.repeat(200),
        altTextPt: `  ${'b'.repeat(200)}  `,
        credit: '  Photo by Rui  ',
      }),
    ).toEqual([]);
    expect(
      await failingFields(PutStudioLandingPhotoDto, {
        ...validPhotoBody,
        altTextEn: '   ',
      }),
    ).toEqual(['altTextEn']);
    expect(
      await failingFields(PutStudioLandingPhotoDto, {
        ...validPhotoBody,
        altTextPt: 'b'.repeat(201),
      }),
    ).toEqual(['altTextPt']);
    expect(
      await failingFields(PutStudioLandingPhotoDto, {
        ...validPhotoBody,
        imageKey: 'javascript:alert(1)',
      }),
    ).toEqual(['imageKey']);
    expect(
      await failingFields(PutStudioLandingPhotoDto, {
        ...validPhotoBody,
        imageKey: '',
      }),
    ).toEqual(['imageKey']);
    expect(
      await failingFields(PutStudioLandingPhotoDto, {
        ...validPhotoBody,
        credit: 'c'.repeat(121),
      }),
    ).toEqual(['credit']);
    expect(
      await failingFields(PutStudioLandingPhotoDto, {
        ...validPhotoBody,
        hasConsent: undefined,
      }),
    ).toEqual(['hasConsent']);
  });

  it('accepts the hero and manifesto slots only', async () => {
    for (const slot of ['hero', 'manifesto']) {
      expect(
        await failingFields(StudioLandingPhotoSlotParams, { slot }),
      ).toEqual([]);
    }
    expect(
      await failingFields(StudioLandingPhotoSlotParams, { slot: 'footer' }),
    ).toEqual(['slot']);
    expect(await failingFields(StudioLandingPhotoSlotParams, {})).toEqual([
      'slot',
    ]);
  });

  it('needs a uuid persona to list a founding artist', async () => {
    expect(
      await failingFields(CreateStudioFoundingArtistDto, {
        subprofileId: PERSONA_ID,
      }),
    ).toEqual([]);
    expect(await failingFields(CreateStudioFoundingArtistDto, {})).toEqual([
      'subprofileId',
    ]);
  });

  it('caps each reorder at its list size', async () => {
    expect(
      await failingFields(ReorderStudioLandingPreviewsDto, {
        previewIds: uuidList(10),
      }),
    ).toEqual([]);
    expect(
      await failingFields(ReorderStudioLandingPreviewsDto, {
        previewIds: uuidList(11),
      }),
    ).toEqual(['previewIds']);
    expect(
      await failingFields(ReorderStudioLandingArtistCardsDto, {
        cardIds: uuidList(6),
      }),
    ).toEqual([]);
    expect(
      await failingFields(ReorderStudioLandingArtistCardsDto, {
        cardIds: uuidList(7),
      }),
    ).toEqual(['cardIds']);
    expect(
      await failingFields(ReorderStudioFoundingArtistsDto, {
        foundingArtistIds: uuidList(50),
      }),
    ).toEqual([]);
    expect(
      await failingFields(ReorderStudioFoundingArtistsDto, {
        foundingArtistIds: uuidList(51),
      }),
    ).toEqual(['foundingArtistIds']);
    expect(
      await failingFields(ReorderStudioFoundingArtistsDto, {
        foundingArtistIds: ['not-a-uuid'],
      }),
    ).toEqual(['foundingArtistIds']);
  });

  it('needs a boolean for the shelf switch and the release wish', async () => {
    expect(
      await failingFields(UpdateStudioLandingSettingsDto, {
        isFoundingShelfVisible: false,
      }),
    ).toEqual([]);
    expect(await failingFields(UpdateStudioLandingSettingsDto, {})).toEqual([
      'isFoundingShelfVisible',
    ]);
    expect(
      await failingFields(CreateStudioAccessRequestDto, {
        wantsToRelease: true,
      }),
    ).toEqual([]);
    expect(await failingFields(CreateStudioAccessRequestDto, {})).toEqual([
      'wantsToRelease',
    ]);
    expect(
      await failingFields(CreateStudioAccessRequestDto, {
        wantsToRelease: 'true',
      }),
    ).toEqual(['wantsToRelease']);
  });

  it('takes an optional cursor of at most 200 characters on the waiting list', async () => {
    expect(await failingFields(AdminStudioAccessRequestsQuery, {})).toEqual([]);
    expect(
      await failingFields(AdminStudioAccessRequestsQuery, { cursor: 'abc' }),
    ).toEqual([]);
    expect(
      await failingFields(AdminStudioAccessRequestsQuery, {
        cursor: 'a'.repeat(201),
      }),
    ).toEqual(['cursor']);
  });
});

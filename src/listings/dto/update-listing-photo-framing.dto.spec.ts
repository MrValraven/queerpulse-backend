import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { AdminUpdateListingDto } from './admin-update-listing.dto';
import { UpdateListingDto } from './update-listing.dto';
import {
  ListingPhotoFramingEntryDto,
  UpdateListingPhotoFramingDto,
} from './update-listing-photo-framing.dto';

const PHOTO_KEY =
  'listing-photos/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.webp';

const validEntry = {
  image: PHOTO_KEY,
  framing: { focusX: 0.25, focusY: 0.75, zoom: 2 },
};

// The real global pipe (`whitelist: true, forbidNonWhitelisted: true`), the
// same way `admin-update-listing.spec.ts` checks `AdminUpdateListingDto`.
// The nested whitelist is enforced only here, so the extra keys are sent next
// to a body the pipe accepts.
describe('UpdateListingPhotoFramingDto through the real ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: UpdateListingPhotoFramingDto,
  };

  it('passes one framed photo and builds nested instances', async () => {
    const transformed = (await pipe.transform(
      { photos: [validEntry] },
      metadata,
    )) as UpdateListingPhotoFramingDto;

    expect(transformed.photos[0]).toBeInstanceOf(ListingPhotoFramingEntryDto);
    expect(transformed.photos[0]?.framing.zoom).toBe(2);
  });

  it('passes an out-of-range zoom, which the service clamps', async () => {
    await expect(
      pipe.transform(
        {
          photos: [
            {
              image: PHOTO_KEY,
              framing: { focusX: 0.5, focusY: 0.5, zoom: 9 },
            },
          ],
        },
        metadata,
      ),
    ).resolves.toBeDefined();
  });

  it('answers 400 to an empty photos list', async () => {
    await expect(
      pipe.transform({ photos: [] }, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 400 to more photos than a gallery holds', async () => {
    const thirteenEntries = Array.from({ length: 13 }, () => validEntry);

    await expect(
      pipe.transform({ photos: thirteenEntries }, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['a string', '0.5'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
  ])('answers 400 to a focusX that is %s', async (_label, focusXValue) => {
    await expect(
      pipe.transform(
        {
          photos: [
            {
              image: PHOTO_KEY,
              framing: { ...validEntry.framing, focusX: focusXValue },
            },
          ],
        },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 400 to an entry with its framing missing', async () => {
    await expect(
      pipe.transform({ photos: [{ image: PHOTO_KEY }] }, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 400 to an entry carrying a caption', async () => {
    await expect(
      pipe.transform(
        { photos: [{ ...validEntry, caption: 'The bar' }] },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 400 to a framing carrying a rotation', async () => {
    await expect(
      pipe.transform(
        {
          photos: [
            {
              image: PHOTO_KEY,
              framing: { ...validEntry.framing, rotation: 90 },
            },
          ],
        },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// A photo's framing is written only through the photo-framing routes. The
// editor bodies keep the whitelist that refuses it, so a client cannot save a
// position as a side effect of saving captions.
describe.each([
  ['UpdateListingDto', UpdateListingDto],
  ['AdminUpdateListingDto', AdminUpdateListingDto],
])('%s keeps framing out of the editor', (_name, dtoClass) => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const metadata: ArgumentMetadata = { type: 'body', metatype: dtoClass };
  const galleryEntry = { image: PHOTO_KEY, alt: 'The bar', caption: '' };

  it('passes a gallery entry with image, alt and caption', async () => {
    await expect(
      pipe.transform({ photoGallery: [galleryEntry] }, metadata),
    ).resolves.toBeDefined();
  });

  it('answers 400 to a gallery entry carrying framing', async () => {
    await expect(
      pipe.transform(
        { photoGallery: [{ ...galleryEntry, framing: validEntry.framing }] },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

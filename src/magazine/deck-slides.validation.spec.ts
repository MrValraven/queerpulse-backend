import { BadRequestException } from '@nestjs/common';
import { validateDeckSlides } from './deck-slides.validation';
import { MAGAZINE_ERROR_CODE } from './magazine-error-codes';

/** What `run` throws, or `undefined`, so a spec can assert its body `code`. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

const VALID_MIXED_DECK = [
  {
    layout: 'text',
    heading: 'A queer decade',
    body: 'Body copy.',
    align: 'left',
  },
  {
    layout: 'image',
    src: 'https://example.com/a.jpg',
    alt: 'A crowd cheering.',
    tint: 'coral',
  },
  {
    layout: 'stat',
    value: '10',
    unit: 'years',
    label: 'since founding',
    tint: 'jade',
  },
  {
    layout: 'interactive',
    kind: 'before-after',
    before: {
      src: 'https://example.com/before.jpg',
      alt: 'Before photo',
      label: 'Before',
    },
    after: {
      src: 'https://example.com/after.jpg',
      alt: 'After photo',
      label: 'After',
    },
  },
  {
    layout: 'interactive',
    kind: 'reveal',
    prompt: 'Guess the year',
    hidden: '2016',
  },
];

describe('validateDeckSlides', () => {
  it('returns the array unchanged for a valid mixed 5-layout deck', () => {
    expect(validateDeckSlides(VALID_MIXED_DECK)).toBe(VALID_MIXED_DECK);
  });

  it('throws when slides is not an array', () => {
    expect(thrownBy(() => validateDeckSlides({}))).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_DECK_SLIDES_INVALID },
    });
  });

  it('throws when slides.length exceeds 40', () => {
    const tooManySlides = Array.from({ length: 41 }, () => ({
      layout: 'text',
      heading: 'Filler heading',
    }));
    expect(thrownBy(() => validateDeckSlides(tooManySlides))).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_DECK_SLIDES_TOO_MANY },
    });
  });

  it('throws when a text slide has no heading, body, or pull', () => {
    expect(
      thrownBy(() =>
        validateDeckSlides([{ layout: 'text', eyebrow: 'Just an eyebrow' }]),
      ),
    ).toMatchObject({
      constructor: BadRequestException,
      response: {
        code: MAGAZINE_ERROR_CODE.MAGAZINE_DECK_SLIDE_FIELD_REQUIRED,
      },
    });
  });

  it('throws when an image slide is missing alt', () => {
    expect(
      thrownBy(() =>
        validateDeckSlides([
          { layout: 'image', src: 'https://example.com/a.jpg', tint: 'coral' },
        ]),
      ),
    ).toMatchObject({
      constructor: BadRequestException,
      response: {
        code: MAGAZINE_ERROR_CODE.MAGAZINE_DECK_SLIDE_FIELD_REQUIRED,
      },
    });
  });

  it('throws when a before-after slide is missing after.label', () => {
    expect(
      thrownBy(() =>
        validateDeckSlides([
          {
            layout: 'interactive',
            kind: 'before-after',
            before: {
              src: 'https://example.com/before.jpg',
              alt: 'Before photo',
              label: 'Before',
            },
            after: {
              src: 'https://example.com/after.jpg',
              alt: 'After photo',
            },
          },
        ]),
      ),
    ).toMatchObject({
      constructor: BadRequestException,
      response: {
        code: MAGAZINE_ERROR_CODE.MAGAZINE_DECK_SLIDE_FIELD_REQUIRED,
      },
    });
  });

  it('throws for an unknown layout', () => {
    expect(
      thrownBy(() => validateDeckSlides([{ layout: 'carousel' }])),
    ).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_DECK_SLIDES_INVALID },
    });
  });
});

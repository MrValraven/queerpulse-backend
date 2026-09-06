import { BadRequestException } from '@nestjs/common';
import {
  isDeckPublishReady,
  validateDeckSlides,
} from './deck-slides.validation';
import { DeckSlide } from './entities/magazine-deck.entity';

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
    expect(() => validateDeckSlides({})).toThrow(BadRequestException);
  });

  it('throws when slides.length exceeds 40', () => {
    const tooManySlides = Array.from({ length: 41 }, () => ({
      layout: 'text',
      heading: 'Filler heading',
    }));
    expect(() => validateDeckSlides(tooManySlides)).toThrow(
      BadRequestException,
    );
  });

  it('throws when a text slide has no heading, body, or pull', () => {
    expect(() =>
      validateDeckSlides([{ layout: 'text', eyebrow: 'Just an eyebrow' }]),
    ).toThrow(BadRequestException);
  });

  it('throws when an image slide is missing alt', () => {
    expect(() =>
      validateDeckSlides([
        { layout: 'image', src: 'https://example.com/a.jpg', tint: 'coral' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('throws when a before-after slide is missing after.label', () => {
    expect(() =>
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
    ).toThrow(BadRequestException);
  });

  it('throws for an unknown layout', () => {
    expect(() => validateDeckSlides([{ layout: 'carousel' }])).toThrow(
      BadRequestException,
    );
  });
});

/**
 * PRD-131 — the server-side mirror of the editor's publish checklist. These
 * assert the same two REQUIRED rows the frontend gates on, so a drift in
 * either place shows up here.
 */
describe('isDeckPublishReady', () => {
  const TEXT_SLIDE: DeckSlide = { layout: 'text', body: 'A slide.' };

  it('refuses an empty deck', () => {
    expect(isDeckPublishReady([])).toBe(false);
  });

  it('accepts a deck with a slide and no images at all', () => {
    expect(isDeckPublishReady([TEXT_SLIDE])).toBe(true);
  });

  it('refuses an image slide whose alt text is blank', () => {
    expect(
      isDeckPublishReady([
        TEXT_SLIDE,
        {
          layout: 'image',
          src: 'https://example.com/a.jpg',
          alt: '   ',
          tint: 'coral',
        },
      ]),
    ).toBe(false);
  });

  it('accepts an image slide with real alt text', () => {
    expect(
      isDeckPublishReady([
        {
          layout: 'image',
          src: 'https://example.com/a.jpg',
          alt: 'A crowd cheering.',
          tint: 'coral',
        },
      ]),
    ).toBe(true);
  });

  it('leaves the optional stat-slide source line alone', () => {
    expect(
      isDeckPublishReady([
        { layout: 'stat', value: '10', label: 'years', tint: 'coral' },
      ]),
    ).toBe(true);
  });
});

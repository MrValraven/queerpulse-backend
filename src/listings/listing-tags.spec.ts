import { BadRequestException } from '@nestjs/common';
import {
  LISTING_TAG_GROUPS,
  LISTING_TAG_OPTIONS,
  normalizeListingTags,
  resolveListingTagsOrThrow,
} from './listing-tags';

describe('normalizeListingTags', () => {
  it('stores a vocabulary tag in its canonical spelling whatever the casing sent', () => {
    expect(normalizeListingTags(['vegan OPTIONS', 'dj nights'], [])).toEqual({
      tags: ['Vegan options', 'DJ nights'],
      unknown: [],
    });
  });

  it('trims surrounding whitespace before matching', () => {
    expect(normalizeListingTags(['  Terrace  ', '\tLive music\n'], [])).toEqual(
      { tags: ['Terrace', 'Live music'], unknown: [] },
    );
  });

  it('drops blank entries', () => {
    expect(normalizeListingTags(['', '   ', 'Workshops'], [])).toEqual({
      tags: ['Workshops'],
      unknown: [],
    });
  });

  it('keeps the first of any repeats, compared case-insensitively', () => {
    expect(
      normalizeListingTags(['Classes', 'classes', ' CLASSES ', 'Terrace'], []),
    ).toEqual({ tags: ['Classes', 'Terrace'], unknown: [] });
  });

  it('reports a tag outside the vocabulary as unknown', () => {
    expect(normalizeListingTags(['Terrace', 'Dog-friendly'], [])).toEqual({
      tags: ['Terrace'],
      unknown: ['Dog-friendly'],
    });
  });

  it('keeps a legacy tag the listing already carries, in the listing spelling', () => {
    expect(
      normalizeListingTags(
        ['walk-ins welcome', 'Terrace'],
        ['Walk-ins welcome'],
      ),
    ).toEqual({ tags: ['Walk-ins welcome', 'Terrace'], unknown: [] });
  });

  it('rejects a legacy tag the listing does not already carry', () => {
    expect(
      normalizeListingTags(['Walk-ins welcome'], ['Dog-friendly']),
    ).toEqual({ tags: [], unknown: ['Walk-ins welcome'] });
  });

  it('prefers the canonical spelling when an existing tag differs only in case', () => {
    expect(normalizeListingTags(['terrace'], ['TERRACE'])).toEqual({
      tags: ['Terrace'],
      unknown: [],
    });
  });

  it('keeps the requested order', () => {
    expect(
      normalizeListingTags(['Terrace', 'Workshops', 'Free entry'], []).tags,
    ).toEqual(['Terrace', 'Workshops', 'Free entry']);
  });
});

describe('resolveListingTagsOrThrow', () => {
  it('returns the normalized tags when every tag is known', () => {
    expect(resolveListingTagsOrThrow(['free ENTRY'], [])).toEqual([
      'Free entry',
    ]);
  });

  it('throws a 400 naming each unknown tag', () => {
    const attempt = () =>
      resolveListingTagsOrThrow(['Terrace', 'Dog-friendly', 'Rooftop'], []);

    expect(attempt).toThrow(BadRequestException);
    expect(attempt).toThrow(/"Dog-friendly", "Rooftop"/);
  });
});

describe('LISTING_TAG_GROUPS', () => {
  it('keeps every tag at 24 characters or fewer, so each fits a pill', () => {
    const overlongTags = LISTING_TAG_OPTIONS.filter((tag) => tag.length > 24);

    expect(overlongTags).toEqual([]);
  });

  it('holds each tag once across all groups, compared case-insensitively', () => {
    const lowercaseTags = LISTING_TAG_OPTIONS.map((tag) => tag.toLowerCase());

    expect(new Set(lowercaseTags).size).toBe(lowercaseTags.length);
  });

  it('stores no tag with surrounding whitespace', () => {
    expect(LISTING_TAG_OPTIONS.filter((tag) => tag !== tag.trim())).toEqual([]);
  });

  it('flattens into LISTING_TAG_OPTIONS in group order', () => {
    expect(LISTING_TAG_OPTIONS).toEqual(
      LISTING_TAG_GROUPS.flatMap((group) => [...group.tags]),
    );
  });
});

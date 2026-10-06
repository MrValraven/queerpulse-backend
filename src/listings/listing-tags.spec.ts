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

  it('accepts an online-only tag and a place-only tag on one listing', () => {
    expect(resolveListingTagsOrThrow(['mb way', 'Terrace'], [])).toEqual([
      'MB WAY',
      'Terrace',
    ]);
  });

  it('accepts a tag from every online-only group', () => {
    expect(
      resolveListingTagsOrThrow(
        ['Ships worldwide', 'PayPal', 'Free first call'],
        [],
      ),
    ).toEqual(['Ships worldwide', 'PayPal', 'Free first call']);
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

  it('holds each tag once across all options, compared case-insensitively', () => {
    const lowercaseTags = LISTING_TAG_OPTIONS.map((tag) => tag.toLowerCase());

    expect(new Set(lowercaseTags).size).toBe(lowercaseTags.length);
  });

  it('holds each tag once within each list, compared case-insensitively', () => {
    const listsWithRepeats = LISTING_TAG_GROUPS.flatMap((group) =>
      [group.tags, group.onlineTags].filter(
        (tagList) =>
          new Set(tagList.map((tag) => tag.toLowerCase())).size !==
          tagList.length,
      ),
    );

    expect(listsWithRepeats).toEqual([]);
  });

  it('keeps each tag inside one group, whether offered to places or online', () => {
    const groupIdByLowercaseTag = new Map<string, string>();
    const tagsInTwoGroups: string[] = [];
    for (const group of LISTING_TAG_GROUPS) {
      for (const tag of new Set([...group.tags, ...group.onlineTags])) {
        const lowercaseTag = tag.toLowerCase();
        const earlierGroupId = groupIdByLowercaseTag.get(lowercaseTag);
        if (earlierGroupId !== undefined && earlierGroupId !== group.id) {
          tagsInTwoGroups.push(tag);
        }
        groupIdByLowercaseTag.set(lowercaseTag, group.id);
      }
    }

    expect(tagsInTwoGroups).toEqual([]);
  });

  it('gives every group at least one tag in one of its lists', () => {
    const emptyGroupIds = LISTING_TAG_GROUPS.filter(
      (group) => group.tags.length === 0 && group.onlineTags.length === 0,
    ).map((group) => group.id);

    expect(emptyGroupIds).toEqual([]);
  });

  it('stores no tag with surrounding whitespace', () => {
    expect(LISTING_TAG_OPTIONS.filter((tag) => tag !== tag.trim())).toEqual([]);
  });

  it('collects place and online tags into LISTING_TAG_OPTIONS once each, in group order', () => {
    expect(LISTING_TAG_OPTIONS).toEqual([
      ...new Set(
        LISTING_TAG_GROUPS.flatMap((group) => [
          ...group.tags,
          ...group.onlineTags,
        ]),
      ),
    ]);
  });

  it('offers both place-only and online-only tags as options', () => {
    expect(LISTING_TAG_OPTIONS).toEqual(
      expect.arrayContaining(['Terrace', 'DJ nights', 'MB WAY', 'Gift cards']),
    );
  });
});

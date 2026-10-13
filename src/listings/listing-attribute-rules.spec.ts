import { BadRequestException } from '@nestjs/common';
import {
  COVER_FREE_BEFORE_REQUIRED_MESSAGE,
  ListingAttributeRuleInput,
  ListingAttributeRuleOptions,
  SAFER_SPACE_POLICY_URL_REQUIRED_MESSAGE,
  SAFER_SPACE_POLICY_URL_TOO_LONG_MESSAGE,
  attributeNotOfferedMessage,
  highlightNotAllowedMessage,
  highlightNotAnAttributeMessage,
  practiceNotOfferedMessage,
  resolveListingAttributeFields,
  unknownListingAttributesMessage,
} from './listing-attribute-rules';

/** A place in nightlife with nothing said yet. */
const ruleInput = (
  overrides: Partial<ListingAttributeRuleInput> = {},
): ListingAttributeRuleInput => ({
  online: false,
  mobile: false,
  cats: ['nightlife'],
  attributes: [],
  highlights: [],
  entryMode: null,
  coverPolicy: null,
  coverFreeBefore: null,
  payments: [],
  issuesNifInvoices: null,
  inclusionPractices: [],
  saferSpacePolicyUrl: null,
  ...overrides,
});

/** What a create passes: nothing stored yet. */
const createOptions = (
  overrides: Partial<ListingAttributeRuleOptions> = {},
): ListingAttributeRuleOptions => ({
  storedAttributes: [],
  storedInclusionPractices: [],
  hasHighlightsInWrite: false,
  ...overrides,
});

/** The 400 message a call answers, or `'resolved'` when it resolves. */
function outcomeOf(
  input: ListingAttributeRuleInput,
  options: ListingAttributeRuleOptions = createOptions(),
): string {
  try {
    resolveListingAttributeFields(input, options);
    return 'resolved';
  } catch (error) {
    if (error instanceof BadRequestException) return error.message;
    throw error;
  }
}

describe('resolveListingAttributeFields', () => {
  describe('rule 1: the vocabulary', () => {
    it('names every unknown slug in one 400', () => {
      expect(
        outcomeOf(
          ruleInput({ attributes: ['terrace', 'rooftop-pool', 'sauna'] }),
        ),
      ).toBe(
        'Unknown listing attributes: "rooftop-pool", "sauna". Pick from GET /directory/attributes.',
      );
      expect(unknownListingAttributesMessage(['sauna'])).toBe(
        'Unknown listing attributes: "sauna". Pick from GET /directory/attributes.',
      );
    });

    it('stores known slugs trimmed, lowercased and once each, in the order sent', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({ attributes: [' Terrace', 'dj-nights', 'TERRACE'] }),
          createOptions(),
        ).attributes,
      ).toEqual(['terrace', 'dj-nights']);
    });
  });

  describe('rule 2: the offer', () => {
    it('refuses a slug the listing is not offered', () => {
      expect(
        outcomeOf(ruleInput({ cats: ['grooming'], attributes: ['dj-nights'] })),
      ).toBe(attributeNotOfferedMessage('dj-nights'));
      expect(attributeNotOfferedMessage('dj-nights')).toBe(
        'Attribute "dj-nights" is not offered to this listing.',
      );
    });

    it('refuses a premises-only slug on an out and about listing', () => {
      expect(
        outcomeOf(
          ruleInput({ mobile: true, cats: ['tours'], attributes: ['terrace'] }),
        ),
      ).toBe(attributeNotOfferedMessage('terrace'));
    });

    it('keeps a carried slug after the categories changed', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({
            cats: ['grooming'],
            attributes: ['dj-nights', 'priced-by-service'],
            highlights: ['dj-nights'],
          }),
          createOptions({ storedAttributes: ['dj-nights'] }),
        ),
      ).toMatchObject({
        attributes: ['dj-nights', 'priced-by-service'],
        highlights: ['dj-nights'],
      });
    });
  });

  describe('rule 3: highlights', () => {
    it('drops a highlight whose attribute this write removed, with no error', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({
            attributes: ['live-music'],
            highlights: ['live-music', 'dj-nights'],
          }),
          createOptions({ storedAttributes: ['live-music', 'dj-nights'] }),
        ).highlights,
      ).toEqual(['live-music']);
    });

    it('refuses a sent highlight that is not one of the attributes', () => {
      expect(
        outcomeOf(
          ruleInput({ attributes: ['dj-nights'], highlights: ['live-music'] }),
          createOptions({ hasHighlightsInWrite: true }),
        ),
      ).toBe(highlightNotAnAttributeMessage('live-music'));
      expect(highlightNotAnAttributeMessage('live-music')).toBe(
        'Highlight "live-music" is not one of this listing\'s attributes.',
      );
    });

    it('refuses a sensitive highlight', () => {
      expect(
        outcomeOf(
          ruleInput({
            cats: ['health'],
            attributes: ['sexual-health-prep'],
            highlights: ['sexual-health-prep'],
          }),
          createOptions({ hasHighlightsInWrite: true }),
        ),
      ).toBe('"sexual-health-prep" cannot be a highlight.');
      expect(highlightNotAllowedMessage('trans-care-experience')).toBe(
        '"trans-care-experience" cannot be a highlight.',
      );
    });

    it('checks a highlight-only write against the attributes the row already holds', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({ attributes: ['dj-nights'], highlights: ['DJ-nights'] }),
          createOptions({
            storedAttributes: ['dj-nights'],
            hasHighlightsInWrite: true,
          }),
        ).highlights,
      ).toEqual(['dj-nights']);
    });
  });

  describe('rules 4 to 6: getting in', () => {
    it('forces every in-person fact empty on an online listing, whatever the body says', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({
            online: true,
            cats: ['classes'],
            entryMode: 'walkIn',
            coverPolicy: 'free',
            coverFreeBefore: '22:00',
            payments: ['cash'],
          }),
          createOptions(),
        ),
      ).toMatchObject({
        entryMode: null,
        coverPolicy: null,
        coverFreeBefore: null,
        payments: [],
      });
    });

    it('keeps the way in and ways to pay on an out and about listing', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({
            mobile: true,
            cats: ['tours'],
            entryMode: 'walkIn',
            payments: ['cash', 'mbway'],
          }),
          createOptions(),
        ),
      ).toMatchObject({ entryMode: 'walkIn', payments: ['mbway', 'cash'] });
    });

    it('clears the cover on a listing with no nightlife or culture category', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({
            cats: ['grooming'],
            coverPolicy: 'freeBefore',
            coverFreeBefore: '23:00',
          }),
          createOptions(),
        ),
      ).toMatchObject({ coverPolicy: null, coverFreeBefore: null });
    });

    it('keeps the time for freeBefore and clears it for every other cover', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({ coverPolicy: 'freeBefore', coverFreeBefore: '23:30' }),
          createOptions(),
        ),
      ).toMatchObject({ coverPolicy: 'freeBefore', coverFreeBefore: '23:30' });
      expect(
        resolveListingAttributeFields(
          ruleInput({
            cats: ['culture'],
            coverPolicy: 'ticketed',
            coverFreeBefore: '23:30',
          }),
          createOptions(),
        ),
      ).toMatchObject({ coverPolicy: 'ticketed', coverFreeBefore: null });
    });

    it('asks for the time when the cover is freeBefore', () => {
      expect(outcomeOf(ruleInput({ coverPolicy: 'freeBefore' }))).toBe(
        COVER_FREE_BEFORE_REQUIRED_MESSAGE,
      );
      expect(COVER_FREE_BEFORE_REQUIRED_MESSAGE).toBe(
        'coverFreeBefore is required when coverPolicy is freeBefore.',
      );
    });

    it('stores ways to pay once each, in vocabulary order', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({ payments: ['cash', 'card', 'cash'] }),
          createOptions(),
        ).payments,
      ).toEqual(['card', 'cash']);
    });

    it('keeps the NIF invoice answer for every kind of listing', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({
            online: true,
            cats: ['classes'],
            issuesNifInvoices: true,
          }),
          createOptions(),
        ).issuesNifInvoices,
      ).toBe(true);
    });
  });

  describe('rule 7: inclusion practices', () => {
    it('refuses a new practice outside its scope', () => {
      expect(
        outcomeOf(
          ruleInput({
            online: true,
            cats: ['classes'],
            inclusionPractices: ['named-contact'],
          }),
        ),
      ).toBe('Practice "named-contact" is not offered to this listing.');
      expect(practiceNotOfferedMessage('harm-reduction')).toBe(
        'Practice "harm-reduction" is not offered to this listing.',
      );
    });

    it('keeps a stored practice after the listing went online', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({
            online: true,
            cats: ['classes'],
            inclusionPractices: ['named-contact', 'chosen-name'],
          }),
          createOptions({ storedInclusionPractices: ['named-contact'] }),
        ).inclusionPractices,
      ).toEqual(['chosen-name', 'named-contact']);
    });

    it('asks for the policy link when safer-space-policy is set', () => {
      expect(
        outcomeOf(ruleInput({ inclusionPractices: ['safer-space-policy'] })),
      ).toBe(SAFER_SPACE_POLICY_URL_REQUIRED_MESSAGE);
      expect(
        outcomeOf(
          ruleInput({
            inclusionPractices: ['safer-space-policy'],
            saferSpacePolicyUrl: '   ',
          }),
        ),
      ).toBe('saferSpacePolicyUrl is required when safer-space-policy is set.');
    });

    it('stores the policy link with https:// when it was typed without one', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({
            inclusionPractices: ['safer-space-policy'],
            saferSpacePolicyUrl: 'casa-t.pt/safer-space',
          }),
          createOptions(),
        ).saferSpacePolicyUrl,
      ).toBe('https://casa-t.pt/safer-space');
    });

    it('refuses a link that outgrows the column once https:// is added', () => {
      const typedUrl = `casa-t.pt/${'a'.repeat(290)}`;
      expect(typedUrl).toHaveLength(300);
      expect(
        outcomeOf(
          ruleInput({
            inclusionPractices: ['safer-space-policy'],
            saferSpacePolicyUrl: typedUrl,
          }),
        ),
      ).toBe(SAFER_SPACE_POLICY_URL_TOO_LONG_MESSAGE);
      expect(SAFER_SPACE_POLICY_URL_TOO_LONG_MESSAGE).toBe(
        'saferSpacePolicyUrl must be at most 300 characters once https:// is added.',
      );
    });

    it('clears the link when the practice is not set', () => {
      expect(
        resolveListingAttributeFields(
          ruleInput({ saferSpacePolicyUrl: 'https://casa-t.pt/safer-space' }),
          createOptions(),
        ).saferSpacePolicyUrl,
      ).toBeNull();
    });
  });

  it('reads a row from before the columns existed as nothing said', () => {
    expect(
      resolveListingAttributeFields(
        {
          online: false,
          mobile: false,
          cats: ['food'],
          attributes: undefined,
          highlights: undefined,
          entryMode: undefined,
          coverPolicy: undefined,
          coverFreeBefore: undefined,
          payments: undefined,
          issuesNifInvoices: undefined,
          inclusionPractices: undefined,
          saferSpacePolicyUrl: undefined,
        },
        {
          storedAttributes: undefined,
          storedInclusionPractices: undefined,
          hasHighlightsInWrite: false,
        },
      ),
    ).toEqual({
      attributes: [],
      highlights: [],
      entryMode: null,
      coverPolicy: null,
      coverFreeBefore: null,
      payments: [],
      issuesNifInvoices: null,
      inclusionPractices: [],
      saferSpacePolicyUrl: null,
    });
  });
});

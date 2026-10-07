import {
  LISTING_ACCESSIBILITY_QUESTION_SLUGS,
  LISTING_ALL_ACCESSIBILITY_QUESTION_SLUGS,
  LISTING_ONLINE_ACCESSIBILITY_QUESTION_SLUGS,
  ListingAccessibilityAnswer,
  isListingAnyAccessibilityQuestionSlug,
  normalizeAccessibilityAnswers,
  normalizeListingAccessibilityAnswers,
} from './listing-accessibility';

describe('listing accessibility vocabulary', () => {
  it('keeps the six place questions that gatherings share unchanged', () => {
    expect(LISTING_ACCESSIBILITY_QUESTION_SLUGS).toEqual([
      'step-free-entrance',
      'wheelchair-accessible-interior',
      'accessible-toilet',
      'gender-neutral-toilet',
      'quiet-hours',
      'assistance-animals-welcome',
    ]);
    expect(Object.keys(normalizeAccessibilityAnswers({}))).toHaveLength(6);
  });

  it('appends the four online questions after the six', () => {
    expect(LISTING_ALL_ACCESSIBILITY_QUESTION_SLUGS).toEqual([
      ...LISTING_ACCESSIBILITY_QUESTION_SLUGS,
      'image-descriptions',
      'video-captions',
      'size-inclusive',
      'plain-language',
    ]);
  });

  it('fills a six-answer row up to all ten, the new ones as unknown', () => {
    const answers = normalizeListingAccessibilityAnswers({
      'step-free-entrance': 'yes',
      'quiet-hours': 'no',
    });

    expect(Object.keys(answers)).toEqual([
      ...LISTING_ALL_ACCESSIBILITY_QUESTION_SLUGS,
    ]);
    expect(answers['step-free-entrance']).toBe(ListingAccessibilityAnswer.Yes);
    expect(answers['quiet-hours']).toBe(ListingAccessibilityAnswer.No);
    expect(answers['image-descriptions']).toBe(
      ListingAccessibilityAnswer.Unknown,
    );
  });

  it('keeps an online answer and drops an unknown question or answer', () => {
    const answers = normalizeListingAccessibilityAnswers({
      'video-captions': 'yes',
      'plain-language': 'maybe',
      'hearing-loop': 'yes',
    });

    expect(answers['video-captions']).toBe(ListingAccessibilityAnswer.Yes);
    expect(answers['plain-language']).toBe(ListingAccessibilityAnswer.Unknown);
    expect(answers).not.toHaveProperty('hearing-loop');
  });

  it('reads a missing map as ten unknown answers', () => {
    expect(Object.values(normalizeListingAccessibilityAnswers(null))).toEqual(
      LISTING_ALL_ACCESSIBILITY_QUESTION_SLUGS.map(
        () => ListingAccessibilityAnswer.Unknown,
      ),
    );
  });

  it('recognises every listing question and nothing else', () => {
    for (const slug of LISTING_ONLINE_ACCESSIBILITY_QUESTION_SLUGS) {
      expect(isListingAnyAccessibilityQuestionSlug(slug)).toBe(true);
    }
    expect(isListingAnyAccessibilityQuestionSlug('quiet-hours')).toBe(true);
    expect(isListingAnyAccessibilityQuestionSlug('hearing-loop')).toBe(false);
  });
});

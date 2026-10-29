import {
  STUDIO_LANDING_MEMO_MILLISECONDS,
  invalidateStudioLandingMemo,
  resetStudioLandingMemoForTesting,
  studioLandingMemoGeneration,
} from './studio-landing-memo';

describe('Studio landing memo', () => {
  afterEach(() => {
    resetStudioLandingMemoForTesting();
  });

  it('keeps a built page for sixty seconds', () => {
    expect(STUDIO_LANDING_MEMO_MILLISECONDS).toBe(60_000);
  });

  it('moves the generation on every invalidate', () => {
    const before = studioLandingMemoGeneration();
    invalidateStudioLandingMemo();
    expect(studioLandingMemoGeneration()).toBe(before + 1);
    invalidateStudioLandingMemo();
    expect(studioLandingMemoGeneration()).toBe(before + 2);
  });

  it('starts again from zero after a reset', () => {
    invalidateStudioLandingMemo();
    resetStudioLandingMemoForTesting();
    expect(studioLandingMemoGeneration()).toBe(0);
  });
});

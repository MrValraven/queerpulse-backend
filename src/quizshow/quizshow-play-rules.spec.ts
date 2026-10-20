import { isEarlyAccessFeature, isFeatureLaunched } from '../launchedFeatures';
import { isAdultsOnlySession, isQuizshowPlayable } from './quizshow-play-rules';

jest.mock('../launchedFeatures', () => ({
  isFeatureLaunched: jest.fn(),
  isEarlyAccessFeature: jest.fn(),
}));

const mockIsFeatureLaunched = isFeatureLaunched as jest.MockedFunction<
  typeof isFeatureLaunched
>;
const mockIsEarlyAccessFeature = isEarlyAccessFeature as jest.MockedFunction<
  typeof isEarlyAccessFeature
>;

describe('quizshow play rules', () => {
  beforeEach(() => {
    mockIsFeatureLaunched.mockReset();
    mockIsEarlyAccessFeature.mockReset();
  });

  it('answers 18+ when the scope flag is on or the snapshot holds an adults round', () => {
    const plainSnapshot = {
      rounds: [
        { contentLabel: 'none' as const },
        { contentLabel: 'spicy' as const },
      ],
    };
    const adultsSnapshot = {
      rounds: [
        { contentLabel: 'none' as const },
        { contentLabel: 'adults' as const },
      ],
    };
    const emptySnapshot = { rounds: [] };

    expect(isAdultsOnlySession(true, plainSnapshot)).toBe(true);
    expect(isAdultsOnlySession(true, emptySnapshot)).toBe(true);
    expect(isAdultsOnlySession(false, adultsSnapshot)).toBe(true);
    expect(isAdultsOnlySession(true, adultsSnapshot)).toBe(true);
    expect(isAdultsOnlySession(false, plainSnapshot)).toBe(false);
    expect(isAdultsOnlySession(false, emptySnapshot)).toBe(false);
    expect(
      isAdultsOnlySession(false, {
        rounds: [{ contentLabel: 'sensitive' as const }],
      }),
    ).toBe(false);
  });

  it('is playable while launched or in early access and closed otherwise', () => {
    mockIsFeatureLaunched.mockReturnValue(true);
    mockIsEarlyAccessFeature.mockReturnValue(false);
    expect(isQuizshowPlayable()).toBe(true);
    expect(mockIsFeatureLaunched).toHaveBeenCalledWith('quizshow');

    mockIsFeatureLaunched.mockReturnValue(false);
    mockIsEarlyAccessFeature.mockReturnValue(true);
    expect(isQuizshowPlayable()).toBe(true);
    expect(mockIsEarlyAccessFeature).toHaveBeenCalledWith('quizshow');

    mockIsFeatureLaunched.mockReturnValue(true);
    mockIsEarlyAccessFeature.mockReturnValue(true);
    expect(isQuizshowPlayable()).toBe(true);

    mockIsFeatureLaunched.mockReturnValue(false);
    mockIsEarlyAccessFeature.mockReturnValue(false);
    expect(isQuizshowPlayable()).toBe(false);
  });
});

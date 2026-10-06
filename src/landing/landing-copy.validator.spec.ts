import { BadRequestException } from '@nestjs/common';
import { LandingSection } from './entities/landing-feature.entity';
import {
  LANDING_KICKER_MAX_LENGTH,
  validateLandingCopy,
} from './landing-copy.validator';

describe('validateLandingCopy', () => {
  it('accepts a member quote and strips unknown keys', () => {
    expect(
      validateLandingCopy(LandingSection.Member, {
        quote: 'Real words',
        junk: 1,
      }),
    ).toEqual({ quote: 'Real words' });
  });

  it('rejects a member copy with no quote', () => {
    expect(() => validateLandingCopy(LandingSection.Member, {})).toThrow(
      BadRequestException,
    );
  });

  it('requires cause and blurb for a changemaker', () => {
    expect(() =>
      validateLandingCopy(LandingSection.Changemaker, { cause: 'x' }),
    ).toThrow(BadRequestException);
    expect(
      validateLandingCopy(LandingSection.Changemaker, {
        cause: 'x',
        blurb: 'y',
        tags: ['a'],
      }),
    ).toEqual({ cause: 'x', blurb: 'y', tags: ['a'] });
  });

  it('accepts an optional short kicker for a gathering and a story', () => {
    expect(validateLandingCopy(LandingSection.Gathering, {})).toEqual({});
    expect(
      validateLandingCopy(LandingSection.Story, {
        blurb: '  Editor pick  ',
        junk: 1,
      }),
    ).toEqual({ blurb: 'Editor pick' });
  });

  it('rejects a gathering kicker longer than the cap', () => {
    expect(() =>
      validateLandingCopy(LandingSection.Gathering, {
        blurb: 'x'.repeat(LANDING_KICKER_MAX_LENGTH + 1),
      }),
    ).toThrow(BadRequestException);
  });

  it('allows an empty community blurb (optional)', () => {
    expect(validateLandingCopy(LandingSection.Community, {})).toEqual({});
  });
});

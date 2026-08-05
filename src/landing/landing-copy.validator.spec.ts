import { BadRequestException } from '@nestjs/common';
import { LandingSection } from './entities/landing-feature.entity';
import { validateLandingCopy } from './landing-copy.validator';

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

  it('allows an empty community blurb (optional)', () => {
    expect(validateLandingCopy(LandingSection.Community, {})).toEqual({});
  });
});

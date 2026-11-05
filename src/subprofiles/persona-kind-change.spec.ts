import { UnprocessableEntityException } from '@nestjs/common';
import { SubprofileKind } from './entities/subprofile.entity';
import type { SkinData, TherapistFacts } from './entities/subprofile.entity';
import {
  STUDIO_RELEASE_COUNTS_SQL,
  countStudioReleasesByStatus,
  hasStudioFormatChange,
  personaKindChangeException,
  personaKindRuleRejection,
  skinDataAfterKindSwitch,
  studioReleaseRejection,
} from './persona-kind-change';
import { availabilityAfterTattooSync } from './tattoo-books-status';

const {
  Musician,
  Dj,
  Drag,
  Ceramicist,
  Jeweler,
  Poet,
  SpokenWord,
  Generic,
  Therapist,
  TattooArtist,
} = SubprofileKind;

const therapistFactsFixture: TherapistFacts = {
  status: 'open',
  waitNote: '',
  title: 'Clinical psychologist',
  registration: 'OPP 21044',
  quote: 'A quiet *hour* of your week',
  languages: 'Portuguese, English',
  where: 'Arroios, Lisbon',
  online: 'yes',
  timezone: '',
  email: '',
  website: '',
  goodToKnow: '',
};

describe('personaKindRuleRejection', () => {
  it('rejects the same kind first', () =>
    expect(personaKindRuleRejection(Musician, Musician)).toEqual({
      code: 'PERSONA_KIND_UNCHANGED',
    }));
  it('rejects generic to generic as unchanged', () =>
    expect(personaKindRuleRejection(Generic, Generic)).toEqual({
      code: 'PERSONA_KIND_UNCHANGED',
    }));
  it('allows musician to dj', () =>
    expect(personaKindRuleRejection(Musician, Dj)).toBeNull());
  it('rejects musician to ceramicist with both families', () =>
    expect(personaKindRuleRejection(Musician, Ceramicist)).toEqual({
      code: 'PERSONA_KIND_OTHER_FAMILY',
      currentFamily: 'stage',
      requestedFamily: 'workshop',
    }));
  it('lets generic switch into any family', () => {
    expect(personaKindRuleRejection(Generic, Musician)).toBeNull();
    expect(personaKindRuleRejection(Generic, Therapist)).toBeNull();
  });
  it('lets a workshop kind switch into generic', () =>
    expect(personaKindRuleRejection(Ceramicist, Generic)).toBeNull());
  it('refuses a stage kind switching into generic', () =>
    expect(personaKindRuleRejection(Musician, Generic)).toEqual({
      code: 'PERSONA_KIND_OTHER_FAMILY',
      currentFamily: 'stage',
      requestedFamily: 'workshop',
    }));
});

describe('hasStudioFormatChange', () => {
  it.each([
    [Musician, Dj, false],
    [Musician, Drag, true],
    [Musician, Ceramicist, true],
    [Ceramicist, Jeweler, false],
    [Poet, SpokenWord, false],
    [Generic, Musician, true],
  ])('%s to %s differs: %s', (current, requested, expected) =>
    expect(hasStudioFormatChange(current, requested)).toBe(expected),
  );
});

describe('studioReleaseRejection', () => {
  it('passes with no releases', () =>
    expect(
      studioReleaseRejection(Ceramicist, { takenDownCount: 0, activeCount: 0 }),
    ).toBeNull());
  it('names taken-down releases before any other status', () =>
    expect(
      studioReleaseRejection(Ceramicist, { takenDownCount: 1, activeCount: 3 }),
    ).toEqual({ code: 'PERSONA_KIND_STUDIO_TAKEN_DOWN', takenDownCount: 1 }));
  it('counts releases for a kind with no Studio format', () =>
    expect(
      studioReleaseRejection(Ceramicist, { takenDownCount: 0, activeCount: 3 }),
    ).toEqual({
      code: 'PERSONA_KIND_STUDIO_RELEASES',
      releaseCount: 3,
      requestedHasStudio: false,
    }));
  it('says the requested kind has Studio when its format differs', () =>
    expect(
      studioReleaseRejection(Drag, { takenDownCount: 0, activeCount: 2 }),
    ).toEqual({
      code: 'PERSONA_KIND_STUDIO_RELEASES',
      releaseCount: 2,
      requestedHasStudio: true,
    }));
});

describe('personaKindChangeException', () => {
  it('answers 422 with code, message and details', () => {
    const exception = personaKindChangeException({
      code: 'PERSONA_KIND_OTHER_FAMILY',
      currentFamily: 'stage',
      requestedFamily: 'workshop',
    });
    expect(exception).toBeInstanceOf(UnprocessableEntityException);
    expect(exception.getResponse()).toEqual({
      code: 'PERSONA_KIND_OTHER_FAMILY',
      message: expect.any(String),
      currentFamily: 'stage',
      requestedFamily: 'workshop',
    });
  });
  it('names the release count in the message', () => {
    const body = personaKindChangeException({
      code: 'PERSONA_KIND_STUDIO_RELEASES',
      releaseCount: 3,
      requestedHasStudio: false,
    }).getResponse() as { message: string };
    expect(body.message).toContain('3 Studio releases');
    expect(body.message).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('countStudioReleasesByStatus', () => {
  it('splits taken-down releases from every other status', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        { status: 'draft', count: '2' },
        { status: 'published', count: 1 },
        { status: 'taken_down', count: '1' },
      ]),
    };
    await expect(countStudioReleasesByStatus(manager, 'sp-1')).resolves.toEqual(
      { takenDownCount: 1, activeCount: 3 },
    );
    expect(manager.query).toHaveBeenCalledWith(STUDIO_RELEASE_COUNTS_SQL, [
      'sp-1',
    ]);
    expect(STUDIO_RELEASE_COUNTS_SQL).toContain('"studio_releases"');
  });
});

describe('skinDataAfterKindSwitch', () => {
  it('sets the tattoo status from availability and keeps the rest of the block', () => {
    const stored = {
      tattoo: { status: 'closed', waitNote: 'June' },
    } as SkinData;
    expect(skinDataAfterKindSwitch(TattooArtist, stored, 'booking')).toEqual({
      tattoo: { status: 'waitlist', waitNote: 'June' },
    });
    expect(stored.tattoo?.status).toBe('closed');
  });
  it.each(['open_to_collabs', 'booking', 'not_available'])(
    'round-trips %s through availabilityAfterTattooSync',
    (availability) => {
      const result = skinDataAfterKindSwitch(
        TattooArtist,
        { tattoo: { status: 'closed' } },
        availability,
      );
      expect(
        availabilityAfterTattooSync(TattooArtist, result, availability),
      ).toBe(availability);
    },
  );
  it('drops the tattoo status when availability is null, so the next save keeps null', () => {
    const result = skinDataAfterKindSwitch(
      TattooArtist,
      { tattoo: { status: 'open', waitNote: 'x' } },
      null,
    );
    expect(result).toEqual({ tattoo: { waitNote: 'x' } });
    expect(availabilityAfterTattooSync(TattooArtist, result, null)).toBeNull();
  });
  it('returns the same object when there is no tattoo block', () => {
    const stored = { coverBleed: true } as SkinData;
    expect(skinDataAfterKindSwitch(TattooArtist, stored, 'booking')).toBe(
      stored,
    );
  });
  it('sets the therapist status from availability', () => {
    const stored = {
      therapist: { ...therapistFactsFixture, status: 'open' },
    } as SkinData;
    expect(
      skinDataAfterKindSwitch(Therapist, stored, 'not_available')?.therapist
        ?.status,
    ).toBe('closed');
    expect(
      skinDataAfterKindSwitch(Therapist, stored, 'booking')?.therapist?.status,
    ).toBe('wait');
  });
  it('leaves a therapist block alone when availability is null', () => {
    const stored = { therapist: therapistFactsFixture } as SkinData;
    expect(skinDataAfterKindSwitch(Therapist, stored, null)).toBe(stored);
  });
  it('returns the same object for any other kind', () => {
    const stored = { tattoo: { status: 'open' } } as SkinData;
    expect(skinDataAfterKindSwitch(Musician, stored, 'booking')).toBe(stored);
  });
});

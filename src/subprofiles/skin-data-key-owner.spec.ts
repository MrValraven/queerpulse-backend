import {
  publicSkinDataFor,
  SKIN_DATA_KEY_READERS,
} from './skin-data-key-owner';
import {
  SubprofileKind,
  type SkinData,
  type TherapistFacts,
} from './entities/subprofile.entity';

const PRACTICE_BODY_KINDS = [
  SubprofileKind.Coach,
  SubprofileKind.Bodyworker,
  SubprofileKind.YogaTeacher,
  SubprofileKind.Nutritionist,
  SubprofileKind.Doula,
  SubprofileKind.PersonalTrainer,
  SubprofileKind.SexEducator,
  SubprofileKind.PeerSupport,
];

describe('SKIN_DATA_KEY_READERS', () => {
  it.each([
    'tattoo',
    'tattooBooking',
    'tattooStyles',
    'tattooPrices',
    'tattooComfort',
    'tattooHygiene',
    'tattooScarWork',
    'tattooStudio',
    'tattooLineage',
  ])('gives %s to tattoo_artist alone', (key) =>
    expect(SKIN_DATA_KEY_READERS[key]).toEqual([SubprofileKind.TattooArtist]),
  );

  it.each([
    'therapist',
    'lived',
    'contexts',
    'modalities',
    'workingStyle',
    'notFor',
    'boundaries',
    'whoFor',
    'therapyFees',
    'reimbursement',
    'availabilitySummary',
    'travel',
    'accessMissing',
    'worksAlongside',
    'hours',
    'openSlots',
  ])('gives %s to therapist alone', (key) =>
    expect(SKIN_DATA_KEY_READERS[key]).toEqual([SubprofileKind.Therapist]),
  );

  it('gives faq to therapist and tattoo_artist', () =>
    expect([...(SKIN_DATA_KEY_READERS.faq ?? [])].sort()).toEqual(
      [SubprofileKind.TattooArtist, SubprofileKind.Therapist].sort(),
    ));

  it('gives venue to tattoo_artist and every Practice kind', () =>
    expect([...(SKIN_DATA_KEY_READERS.venue ?? [])].sort()).toEqual(
      [
        SubprofileKind.TattooArtist,
        SubprofileKind.Therapist,
        ...PRACTICE_BODY_KINDS,
      ].sort(),
    ));

  it.each(['training', 'availability'])(
    'gives %s to the Practice kinds that render PracticeBody',
    (key) =>
      expect([...(SKIN_DATA_KEY_READERS[key] ?? [])].sort()).toEqual(
        [...PRACTICE_BODY_KINDS].sort(),
      ),
  );

  it.each(['approach', 'practical', 'coverBleed', 'studioHero', 'atTheTable'])(
    'leaves shared key %s unmapped',
    (key) => expect(Object.hasOwn(SKIN_DATA_KEY_READERS, key)).toBe(false),
  );
});

describe('publicSkinDataFor', () => {
  const facts: TherapistFacts = {
    status: 'open',
    waitNote: '',
    title: 'Psychotherapist',
    registration: 'OPP 21044',
    quote: 'A *steady* hour',
    languages: 'Portuguese, English',
    where: 'Arroios, Lisbon',
    online: 'yes',
    timezone: '',
    email: '',
    website: '',
    goodToKnow: '',
  };

  const studioVenue = { name: 'Studio Lume', lines: ['Rua do Benformoso 12'] };
  const therapistPractice: SkinData = {
    therapist: facts,
    lived: ['x'],
    hours: [{ label: 'Mon', value: '9' }],
    openSlots: ['Tue'],
    faq: [{ question: 'Online?', answer: 'Yes' }],
    approach: ['a'],
  };

  it('drops therapist-only keys on a coach and keeps shared ones', () => {
    expect(
      publicSkinDataFor(SubprofileKind.Coach, {
        ...therapistPractice,
        someFutureKey: 1,
      } as SkinData),
    ).toEqual({ approach: ['a'], someFutureKey: 1 });
  });

  it('keeps faq, hours and openSlots on a therapist', () =>
    expect(
      publicSkinDataFor(SubprofileKind.Therapist, therapistPractice),
    ).toEqual(therapistPractice));

  it('keeps owned keys on their own kind', () =>
    expect(
      publicSkinDataFor(SubprofileKind.Therapist, { lived: ['x'] }),
    ).toEqual({ lived: ['x'] }));

  it('strips the studio venue when a tattoo artist becomes an illustrator', () =>
    expect(
      publicSkinDataFor(SubprofileKind.Illustrator, {
        venue: studioVenue,
        coverBleed: true,
      }),
    ).toEqual({ coverBleed: true }));

  it.each(PRACTICE_BODY_KINDS)('keeps the venue on a %s', (kind) =>
    expect(publicSkinDataFor(kind, { venue: studioVenue })).toEqual({
      venue: studioVenue,
    }),
  );

  const trainingAndAvailability = {
    training: [{ title: 'Somatic practice', year: '2020' }],
    availability: { startDate: '2026-11-02', slotTime: '10:00', cells: [] },
  } as unknown as SkinData;

  it.each(PRACTICE_BODY_KINDS)(
    'keeps training and availability on a %s',
    (kind) =>
      expect(publicSkinDataFor(kind, trainingAndAvailability)).toEqual(
        trainingAndAvailability,
      ),
  );

  it('drops training and availability when a coach becomes a therapist', () =>
    expect(
      publicSkinDataFor(SubprofileKind.Therapist, {
        ...trainingAndAvailability,
        approach: ['a'],
      }),
    ).toEqual({ approach: ['a'] }));

  it('passes a key the map does not know', () =>
    expect(
      publicSkinDataFor(SubprofileKind.Dj, {
        someFutureKey: 'kept',
      } as SkinData),
    ).toEqual({ someFutureKey: 'kept' }));

  it('passes a stored key named like an Object.prototype member', () =>
    expect(
      publicSkinDataFor(SubprofileKind.Dj, { toString: 'kept' } as SkinData),
    ).toEqual({ toString: 'kept' }));

  it('returns null for no stored skinData', () =>
    expect(publicSkinDataFor(SubprofileKind.Dj, null)).toBeNull());

  it('leaves the stored object untouched', () => {
    const stored = { tattoo: { status: 'open' } } as SkinData;
    publicSkinDataFor(SubprofileKind.Illustrator, stored);
    expect(stored.tattoo).toEqual({ status: 'open' });
  });
});

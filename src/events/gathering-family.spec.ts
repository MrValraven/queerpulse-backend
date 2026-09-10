import {
  allowedDetailKeys,
  FORMAT_DETAIL_KEYS_BY_FAMILY,
  GATHERING_FAMILY_VALUES,
  GatheringFamily,
  LEGACY_TYPE_BACKFILL,
  stripDisallowedDetails,
} from './gathering-family';

/**
 * The family vocabulary, the per-family details bag and the one-off backfill
 * table, pinned in the one module the migration, the DTO and the service all
 * read. A family that gains a details key here and nowhere else is the whole
 * point: the service strips against this table, so a stale bag left behind by
 * a host switching family is dropped rather than stored or rejected.
 */
describe('gathering family', () => {
  it('declares exactly the nine families', () => {
    expect(GATHERING_FAMILY_VALUES).toEqual([
      GatheringFamily.Meet,
      GatheringFamily.Eat,
      GatheringFamily.Party,
      GatheringFamily.Make,
      GatheringFamily.Learn,
      GatheringFamily.Watch,
      GatheringFamily.Move,
      GatheringFamily.Care,
      GatheringFamily.Organise,
    ]);
  });

  it('gives every family a detail-key list, empty where it asks nothing', () => {
    for (const family of GATHERING_FAMILY_VALUES) {
      expect(FORMAT_DETAIL_KEYS_BY_FAMILY[family]).toBeDefined();
    }
    expect(FORMAT_DETAIL_KEYS_BY_FAMILY[GatheringFamily.Meet]).toEqual([]);
    expect(FORMAT_DETAIL_KEYS_BY_FAMILY[GatheringFamily.Learn]).toEqual([]);
    expect(FORMAT_DETAIL_KEYS_BY_FAMILY[GatheringFamily.Care]).toEqual([]);
    expect(FORMAT_DETAIL_KEYS_BY_FAMILY[GatheringFamily.Organise]).toEqual([]);
    expect(FORMAT_DETAIL_KEYS_BY_FAMILY[GatheringFamily.Eat]).toEqual([
      'bring',
    ]);
    expect(FORMAT_DETAIL_KEYS_BY_FAMILY[GatheringFamily.Make]).toEqual([
      'bring',
    ]);
    expect(FORMAT_DETAIL_KEYS_BY_FAMILY[GatheringFamily.Party]).toEqual([
      'isAdultsOnly',
      'isSoberFriendly',
    ]);
    expect(FORMAT_DETAIL_KEYS_BY_FAMILY[GatheringFamily.Move]).toEqual([
      'terrain',
      'isBeginnerFriendly',
    ]);
    expect(FORMAT_DETAIL_KEYS_BY_FAMILY[GatheringFamily.Watch]).toEqual([
      'runtimeMinutes',
    ]);
  });

  it('allows nothing at all for a null family', () => {
    expect(allowedDetailKeys(null)).toEqual([]);
    expect(allowedDetailKeys(undefined)).toEqual([]);
  });

  describe('stripDisallowedDetails', () => {
    it('keeps only the keys the family allows', () => {
      const stripped = stripDisallowedDetails(GatheringFamily.Move, {
        terrain: 'steep',
        isBeginnerFriendly: true,
        bring: 'water',
        runtimeMinutes: 90,
      });
      expect(stripped).toEqual({ terrain: 'steep', isBeginnerFriendly: true });
    });

    it('returns null when nothing survives the strip', () => {
      expect(
        stripDisallowedDetails(GatheringFamily.Learn, { bring: 'a pen' }),
      ).toBeNull();
    });

    it('returns null for a null family, whatever the bag holds', () => {
      expect(stripDisallowedDetails(null, { bring: 'a pen' })).toBeNull();
    });

    it('returns null for an absent bag', () => {
      expect(stripDisallowedDetails(GatheringFamily.Eat, null)).toBeNull();
      expect(stripDisallowedDetails(GatheringFamily.Eat, undefined)).toBeNull();
    });

    it('drops a key present but undefined rather than storing a hole', () => {
      expect(
        stripDisallowedDetails(GatheringFamily.Eat, { bring: undefined }),
      ).toBeNull();
    });

    // Blank is what a host sends by tabbing past the field, so it means the
    // same thing as leaving the question alone. The DTO cannot say so (a
    // `@MinLength` would 400 an untouched input), which is why the rule lives
    // here.
    it('drops a bring line that is blank or only whitespace', () => {
      expect(
        stripDisallowedDetails(GatheringFamily.Eat, { bring: '   ' }),
      ).toBeNull();
      expect(
        stripDisallowedDetails(GatheringFamily.Eat, { bring: '' }),
      ).toBeNull();
    });

    it('stores a surviving bring line trimmed', () => {
      expect(
        stripDisallowedDetails(GatheringFamily.Eat, { bring: '  soup  ' }),
      ).toEqual({ bring: 'soup' });
    });

    it('keeps a false boolean, which is a real answer', () => {
      expect(
        stripDisallowedDetails(GatheringFamily.Party, {
          isAdultsOnly: false,
          isSoberFriendly: true,
        }),
      ).toEqual({ isAdultsOnly: false, isSoberFriendly: true });
    });
  });

  describe('LEGACY_TYPE_BACKFILL', () => {
    it('covers all eight labels the wizard used to store', () => {
      expect(LEGACY_TYPE_BACKFILL.map((row) => row.legacyLabel)).toEqual([
        'Supper club',
        'Workshop / talk',
        'Screening',
        'Studio visit',
        'Walk or outdoor',
        'Discussion',
        'Skills exchange',
        'Other',
      ]);
    });

    it('maps each label to the spec family and format key', () => {
      const byLabel = new Map(
        LEGACY_TYPE_BACKFILL.map((row) => [row.legacyLabel, row]),
      );
      expect(byLabel.get('Supper club')).toEqual({
        legacyLabel: 'Supper club',
        family: GatheringFamily.Eat,
        formatKey: 'supper-club',
      });
      expect(byLabel.get('Workshop / talk')).toEqual({
        legacyLabel: 'Workshop / talk',
        family: GatheringFamily.Learn,
        formatKey: 'workshop',
      });
      expect(byLabel.get('Screening')).toEqual({
        legacyLabel: 'Screening',
        family: GatheringFamily.Watch,
        formatKey: 'screening',
      });
      expect(byLabel.get('Studio visit')).toEqual({
        legacyLabel: 'Studio visit',
        family: GatheringFamily.Make,
        formatKey: 'studio-visit',
      });
      expect(byLabel.get('Walk or outdoor')).toEqual({
        legacyLabel: 'Walk or outdoor',
        family: GatheringFamily.Move,
        formatKey: 'walk-or-hike',
      });
      expect(byLabel.get('Discussion')).toEqual({
        legacyLabel: 'Discussion',
        family: GatheringFamily.Learn,
        formatKey: 'discussion',
      });
      expect(byLabel.get('Skills exchange')).toEqual({
        legacyLabel: 'Skills exchange',
        family: GatheringFamily.Learn,
        formatKey: 'skills-exchange',
      });
      expect(byLabel.get('Other')).toEqual({
        legacyLabel: 'Other',
        family: null,
        formatKey: null,
      });
    });
  });
});

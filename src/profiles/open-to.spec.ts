import {
  MAX_NOW_LENGTH,
  MAX_OPEN_TO_ENTRIES,
  MAX_OPEN_TO_LABEL_LENGTH,
  OPEN_TO_PRESET_IDS,
  normalizeOpenTo,
} from './open-to';

describe('open-to vocabulary', () => {
  it('exposes exactly the nine shared preset ids', () => {
    expect([...OPEN_TO_PRESET_IDS]).toEqual([
      'collaborating',
      'mentoring',
      'casualMeetups',
      'commissions',
      'clientWork',
      'referrals',
      'swaps',
      'studioVisits',
      'interviewees',
    ]);
  });

  it('exposes the shared limits', () => {
    expect(MAX_OPEN_TO_ENTRIES).toBe(12);
    expect(MAX_OPEN_TO_LABEL_LENGTH).toBe(60);
    expect(MAX_NOW_LENGTH).toBe(280);
  });
});

describe('normalizeOpenTo', () => {
  it('passes a mixed preset/custom list through unchanged', () => {
    expect(
      normalizeOpenTo([
        { kind: 'preset', id: 'mentoring' },
        { kind: 'custom', label: 'A nurse or two for the testing nights' },
      ]),
    ).toEqual([
      { kind: 'preset', id: 'mentoring' },
      { kind: 'custom', label: 'A nurse or two for the testing nights' },
    ]);
  });

  it('preserves the order the member chose, interleaving presets and customs', () => {
    expect(
      normalizeOpenTo([
        { kind: 'custom', label: 'Zine trades' },
        { kind: 'preset', id: 'swaps' },
        { kind: 'custom', label: 'Darkroom time' },
      ]),
    ).toEqual([
      { kind: 'custom', label: 'Zine trades' },
      { kind: 'preset', id: 'swaps' },
      { kind: 'custom', label: 'Darkroom time' },
    ]);
  });

  it('trims surrounding whitespace from custom labels but nothing else', () => {
    expect(
      normalizeOpenTo([{ kind: 'custom', label: '  a NURSE or two  ' }]),
    ).toEqual([{ kind: 'custom', label: 'a NURSE or two' }]);
  });

  it('drops custom entries whose label is empty after trimming', () => {
    expect(
      normalizeOpenTo([
        { kind: 'custom', label: '   ' },
        { kind: 'custom', label: '' },
        { kind: 'preset', id: 'swaps' },
      ]),
    ).toEqual([{ kind: 'preset', id: 'swaps' }]);
  });

  it('de-duplicates presets by id, keeping the first occurrence', () => {
    expect(
      normalizeOpenTo([
        { kind: 'preset', id: 'mentoring' },
        { kind: 'preset', id: 'swaps' },
        { kind: 'preset', id: 'mentoring' },
      ]),
    ).toEqual([
      { kind: 'preset', id: 'mentoring' },
      { kind: 'preset', id: 'swaps' },
    ]);
  });

  it('de-duplicates customs case-insensitively, keeping the first spelling', () => {
    expect(
      normalizeOpenTo([
        { kind: 'custom', label: 'Darkroom Time' },
        { kind: 'custom', label: 'darkroom time' },
      ]),
    ).toEqual([{ kind: 'custom', label: 'Darkroom Time' }]);
  });

  it('does not collide a preset id with a same-spelled custom label', () => {
    expect(
      normalizeOpenTo([
        { kind: 'preset', id: 'mentoring' },
        { kind: 'custom', label: 'mentoring' },
      ]),
    ).toEqual([
      { kind: 'preset', id: 'mentoring' },
      { kind: 'custom', label: 'mentoring' },
    ]);
  });

  it('returns an empty list for an empty input', () => {
    expect(normalizeOpenTo([])).toEqual([]);
  });

  it('drops preset entries with a missing id rather than emitting a broken entry', () => {
    expect(normalizeOpenTo([{ kind: 'preset' }])).toEqual([]);
  });

  it('trims before de-duplicating, so untrimmed and trimmed spellings collapse', () => {
    expect(
      normalizeOpenTo([
        { kind: 'custom', label: '  Zine trades  ' },
        { kind: 'custom', label: 'zine trades' },
      ]),
    ).toEqual([{ kind: 'custom', label: 'Zine trades' }]);
  });

  it('does not cap the number of entries — that is UpdateProfileDto\'s @ArrayMaxSize job', () => {
    const entries = Array.from({ length: 13 }, (_, i) => ({
      kind: 'custom',
      label: `Custom ${i}`,
    }));
    expect(normalizeOpenTo(entries)).toHaveLength(13);
  });
});

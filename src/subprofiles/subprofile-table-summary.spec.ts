import { toCardTableSummary } from './subprofile-table-summary';

describe('toCardTableSummary', () => {
  it('keeps known values in canonical order, deduplicated', () => {
    expect(
      toCardTableSummary('game_master', {
        format: 'both',
        vibe: ['beginner_friendly', 'queer_led', 'queer_led', 'cool'],
        safetyTools: ['x_card'],
      }),
    ).toEqual({ format: 'both', vibe: ['queer_led', 'beginner_friendly'] });
  });

  it('drops an unknown format and a non-array vibe', () => {
    expect(
      toCardTableSummary('game_master', { format: 'zoom', vibe: 'queer_led' }),
    ).toBeUndefined();
    expect(
      toCardTableSummary('game_master', {
        format: 'zoom',
        vibe: ['trans_led'],
      }),
    ).toEqual({ format: null, vibe: ['trans_led'] });
  });

  it('is undefined for an empty or missing block', () => {
    expect(toCardTableSummary('game_master', undefined)).toBeUndefined();
    expect(toCardTableSummary('game_master', null)).toBeUndefined();
    expect(toCardTableSummary('game_master', 'online')).toBeUndefined();
    expect(
      toCardTableSummary('cosplayer', { where: 'Lisbon' }),
    ).toBeUndefined();
  });

  it('is undefined outside the quest family', () => {
    expect(
      toCardTableSummary('poet', { format: 'online', vibe: ['queer_led'] }),
    ).toBeUndefined();
  });
});

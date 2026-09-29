import {
  kindsMatchingSearch,
  KIND_SEARCH_TERMS,
} from './subprofile-kind-search';

describe('kindsMatchingSearch', () => {
  it('finds game masters by DM aliases in both languages', () => {
    for (const term of [
      'dm',
      'DM',
      'gm',
      'dungeon master',
      'Dungeon',
      'mestre de jogo',
      'keeper',
      'storyteller',
    ]) {
      expect(kindsMatchingSearch(term)).toContain('game_master');
    }
  });

  it('matches a Portuguese label with or without accents', () => {
    expect(kindsMatchingSearch('Narração')).toContain('game_master');
    expect(kindsMatchingSearch('narracao')).toContain('game_master');
    expect(kindsMatchingSearch('critica de videojogos')).toContain(
      'game_critic',
    );
  });

  it('matches every kind by its English label', () => {
    expect(kindsMatchingSearch('photographer')).toContain('photographer');
    expect(kindsMatchingSearch('cosplay')).toContain('cosplayer');
  });

  it('matches only at the start of a word', () => {
    expect(kindsMatchingSearch('aster')).not.toContain('game_master');
    expect(kindsMatchingSearch('game')).toEqual(
      expect.arrayContaining([
        'game_master',
        'game_designer',
        'game_night_host',
        'game_critic',
      ]),
    );
  });

  it('requires a whole word for a two-character needle', () => {
    expect(kindsMatchingSearch('es')).toEqual([]);
    expect(kindsMatchingSearch('pr')).toEqual([]);
    expect(kindsMatchingSearch('dm')).toContain('game_master');
    expect(kindsMatchingSearch('gm')).toContain('game_master');
    expect(kindsMatchingSearch('dj')).toContain('dj');
    expect(kindsMatchingSearch('esc')).toContain('ttrpg_designer');
  });

  it('ignores single characters and stop words', () => {
    for (const term of ['', ' ', 'd', 'de', 'DA', 'e', 'of', 'the']) {
      expect(kindsMatchingSearch(term)).toEqual([]);
    }
  });

  it('carries at least an English and a Portuguese label for every kind', () => {
    for (const [kind, terms] of Object.entries(KIND_SEARCH_TERMS)) {
      expect(terms.length).toBeGreaterThanOrEqual(2);
      expect(terms.every((entry) => entry.trim().length > 0)).toBe(true);
      expect(kind).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

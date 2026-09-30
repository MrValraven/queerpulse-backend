import { toPrefixTsQuery } from './magazine-search-query';

describe('toPrefixTsQuery', () => {
  it('prefix-matches a single word', () => {
    expect(toPrefixTsQuery('transition')).toBe('transition:*');
  });

  it('ANDs the words of a phrase, so more words narrow the result', () => {
    expect(toPrefixTsQuery('lisbon housing')).toBe('lisbon:* & housing:*');
  });

  it('lowercases and collapses runs of whitespace', () => {
    expect(toPrefixTsQuery('  Trans   Joy \n')).toBe('trans:* & joy:*');
  });

  // The whole point of tokenizing rather than passing raw input to
  // `to_tsquery`: every one of these characters is an operator or a syntax
  // error in the tsquery language.
  it('strips tsquery operators out of the term', () => {
    expect(toPrefixTsQuery('pride & (parade | march) !2026')).toBe(
      'pride:* & parade:* & march:* & 2026:*',
    );
  });

  // ENG-503: `search_vector` stores folded lexemes, so the needle folds too.
  it('folds Latin-1 accents the way the search_vector does', () => {
    expect(toPrefixTsQuery('acolhimento São Saúde')).toBe(
      'acolhimento:* & sao:* & saude:*',
    );
  });

  // A decomposed accent (base letter plus U+0301 combining acute) composes
  // first, so it folds like the precomposed letter and stays one word.
  it('folds a decomposed accent the same as a precomposed one', () => {
    expect(toPrefixTsQuery('sau\u0301de')).toBe('saude:*');
  });

  it('keeps letters outside the folded Latin-1 set', () => {
    expect(toPrefixTsQuery('Łódź')).toBe('łodź:*');
  });

  it('caps the token count so a pasted paragraph cannot build a huge query', () => {
    const query = toPrefixTsQuery('a b c d e f g h i j k l');
    expect(query).toBe('a:* & b:* & c:* & d:* & e:* & f:* & g:* & h:*');
  });

  // Callers must read `null` as "zero results", never as "no filter".
  it('returns null when there is nothing searchable in the term', () => {
    expect(toPrefixTsQuery('')).toBeNull();
    expect(toPrefixTsQuery('   ')).toBeNull();
    expect(toPrefixTsQuery('!!! ---')).toBeNull();
  });
});

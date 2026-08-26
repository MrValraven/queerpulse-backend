import { foldedTextExpression } from '../connections/connection-search';
import {
  FORUM_POST_SEARCH_FIELDS,
  foldSearchText,
  FORUM_THREAD_SEARCH_COLUMNS,
  FORUM_THREAD_SEARCH_FIELDS,
  PROFILE_SEARCH_COLUMNS,
  PROFILE_SEARCH_FIELDS,
  foldedHaystack,
  foldedSearchQuery,
  foldedSearchTerm,
  qualifyColumn,
  searchRankExpression,
  weightedSearchVector,
} from './search-text';

// The exact expressions `1795100000000-AddSearchTextIndexes` built its indexes
// from. These are copied from that migration on purpose: a migration is frozen
// history, so if the helper ever stops generating them the indexes silently
// stop being used and every search falls back to a sequential scan. Changing a
// field list, a weight, or the folding means a NEW migration, and updating
// these strings alongside it.
const PROFILES_VECTOR_AS_INDEXED =
  `setweight(to_tsvector('simple', translate(lower(coalesce("first_name", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'A') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("last_name", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'A') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("slug", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'A') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("tagline", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'B') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("bio", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'C') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("bio_pt", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'C')`;

const PROFILES_HAYSTACK_AS_INDEXED =
  `translate(lower(coalesce("first_name", '') || ' ' || coalesce("last_name", '') || ' ' || ` +
  `coalesce("slug", '') || ' ' || coalesce("tagline", '') || ' ' || ` +
  `coalesce("bio", '') || ' ' || coalesce("bio_pt", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

const FORUM_THREAD_VECTOR_AS_INDEXED =
  `setweight(to_tsvector('simple', translate(lower(coalesce("title", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'A')`;

const FORUM_THREAD_HAYSTACK_AS_INDEXED =
  `translate(lower(coalesce("title", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

const FORUM_POST_VECTOR_AS_INDEXED =
  `setweight(to_tsvector('simple', translate(lower(coalesce("body", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'B')`;

describe('search-text expressions match the indexes that back them', () => {
  it('profiles tsvector', () => {
    expect(weightedSearchVector('', PROFILE_SEARCH_FIELDS)).toBe(
      PROFILES_VECTOR_AS_INDEXED,
    );
  });

  it('profiles trigram haystack', () => {
    expect(foldedHaystack('', PROFILE_SEARCH_COLUMNS)).toBe(
      PROFILES_HAYSTACK_AS_INDEXED,
    );
  });

  it('forum_thread tsvector', () => {
    expect(weightedSearchVector('', FORUM_THREAD_SEARCH_FIELDS)).toBe(
      FORUM_THREAD_VECTOR_AS_INDEXED,
    );
  });

  it('forum_thread trigram haystack', () => {
    expect(foldedHaystack('', FORUM_THREAD_SEARCH_COLUMNS)).toBe(
      FORUM_THREAD_HAYSTACK_AS_INDEXED,
    );
  });

  it('forum_post tsvector', () => {
    expect(weightedSearchVector('', FORUM_POST_SEARCH_FIELDS)).toBe(
      FORUM_POST_VECTOR_AS_INDEXED,
    );
  });

  it('an alias only qualifies the column references, leaving the shape intact', () => {
    const aliased = weightedSearchVector('p', FORUM_POST_SEARCH_FIELDS);
    expect(aliased).toBe(
      FORUM_POST_VECTOR_AS_INDEXED.replace('"body"', '"p"."body"'),
    );
  });
});

describe('search-text query side', () => {
  it('folds the needle exactly as it folds the haystack', () => {
    const needle = foldedSearchTerm('term');
    const haystack = foldedHaystack('p', ['tagline']);
    const foldingOf = (expression: string) =>
      expression.slice(expression.indexOf("), '") + 3);
    expect(foldingOf(needle)).toBe(foldingOf(haystack));
  });

  it('builds a websearch tsquery over a BOUND parameter, never spliced input', () => {
    const built = foldedSearchQuery('memberSearchTerm');
    expect(built).toContain("websearch_to_tsquery('simple'");
    expect(built).toContain(':memberSearchTerm');
  });

  it('ranks a full-text hit above a trigram-only near miss', () => {
    const rank = searchRankExpression('VEC', 'QRY', 'HAY', 'TERM');
    expect(rank).toBe('(4 * ts_rank(VEC, QRY) + similarity(HAY, TERM))');
  });

  it('quotes a bare column for an index and an aliased one for a query', () => {
    expect(qualifyColumn('', 'bio_pt')).toBe('"bio_pt"');
    expect(qualifyColumn('p', 'bio_pt')).toBe('"p"."bio_pt"');
  });

  it('includes both bios in the member haystack, which member search skipped', () => {
    expect(PROFILE_SEARCH_COLUMNS).toContain('bio');
    expect(PROFILE_SEARCH_COLUMNS).toContain('bio_pt');
    expect(PROFILE_SEARCH_FIELDS.map((field) => field.column)).toContain(
      'bio_pt',
    );
  });
});

describe('foldSearchText mirrors the SQL fold', () => {
  it('uses exactly the character pair the SQL translate() uses', () => {
    // Pull the two maps straight out of the SQL the connections search builds,
    // so a change there fails here instead of silently misaligning excerpts.
    const sqlPairs = foldedTextExpression('x').match(/'([^']*)'/g);
    expect(sqlPairs).toHaveLength(2);
    const [accented, plain] = (sqlPairs as string[]).map((quoted) =>
      quoted.slice(1, -1),
    );
    expect(accented).toBeDefined();
    expect(plain).toBeDefined();
    expect(foldSearchText(accented as string)).toBe(plain);
  });

  it('lowercases and strips diacritics', () => {
    expect(foldSearchText('São Bento')).toBe('sao bento');
    expect(foldSearchText('Inês')).toBe('ines');
  });

  it('returns one character for every character in, so indexes stay aligned', () => {
    const source = 'Clínica de saúde em São Bento';
    expect(foldSearchText(source)).toHaveLength(source.length);
    expect(foldSearchText(source).indexOf('sao bento')).toBe(
      source.indexOf('São Bento'),
    );
  });
});

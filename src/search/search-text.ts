/**
 * The SQL vocabulary global search is built on (SOC-08).
 *
 * Before this, every `searchByText` was a bare `ILIKE '%term%'` ordered by
 * recency: no ranking, no accent folding, on a product whose audience writes
 * Portuguese, so "Sao" never found "São". This module owns the three pieces
 * that fix that, in ONE place so a query predicate and the index backing it
 * cannot drift apart:
 *
 *  1. **Accent folding.** Reuses `foldedTextExpression` from the connections
 *     list search: `translate(lower(x), 'áàâã…', 'aaaa…')`. `unaccent()` is
 *     only STABLE, so it can back neither an expression index nor a generated
 *     column without a hand-written IMMUTABLE wrapper. `translate()` IS
 *     immutable and needs no extension, so the same expression serves the
 *     predicate and the index.
 *  2. **A weighted `tsvector`.** `setweight(to_tsvector('simple', folded), …)`
 *     so a hit in a title outranks a hit in a body. `to_tsvector` with a
 *     literal regconfig is immutable, so the whole expression is indexable.
 *  3. **A `websearch_to_tsquery` needle**, folded identically to the haystack,
 *     plus `ts_rank` over the pair.
 *
 * The configuration is `simple` rather than `portuguese` or `english`
 * deliberately: this corpus is bilingual, and a stemmer only helps when the
 * document and the query happen to be in the language it was built for. A
 * Portuguese stemmer applied to an English post body mangles both sides
 * consistently but usefully stems neither. `simple` plus accent folding gives
 * exact token matching in both languages, and the trigram `LIKE` branch below
 * covers the partial-word matches a stemmer would otherwise have caught.
 *
 * Every caller ORs the full-text branch with the old folded-substring branch.
 * That is not belt and braces: full text matches whole tokens, so searching
 * "trans" would stop finding "transfeminine" if the `ILIKE` behaviour were
 * simply replaced. Ranking then puts the full-text hits first.
 *
 * ⚠️ The expression strings produced here are frozen by the indexes in
 * `1795100000000-AddSearchTextIndexes`. Changing a field list, a weight, or
 * the folding means a NEW migration rebuilding those indexes: the old ones
 * would silently stop being used. `search-text.spec.ts` pins the exact output
 * against the SQL that migration wrote, so an accidental change fails there.
 */
import { foldedTextExpression } from '../connections/connection-search';

/** The text-search configuration used on BOTH sides of every comparison. */
export const SEARCH_TEXT_CONFIG = 'simple';

/** Postgres `tsvector` weight labels, strongest first. */
export type SearchFieldWeight = 'A' | 'B' | 'C' | 'D';

export interface WeightedSearchField {
  /** Snake_case column name, unquoted: `qualifyColumn` quotes it. */
  column: string;
  weight: SearchFieldWeight;
}

/**
 * `"alias"."column"` for a query builder, or bare `"column"` when `alias` is
 * empty (what a `CREATE INDEX` expression needs). Postgres resolves both to
 * the same parsed expression, so an index built on the bare form is still
 * matched by a query that qualifies it.
 */
export function qualifyColumn(alias: string, column: string): string {
  return alias ? `"${alias}"."${column}"` : `"${column}"`;
}

const coalesced = (columnSql: string): string => `coalesce(${columnSql}, '')`;

/**
 * One folded text blob over several columns, for the substring (`LIKE`) branch
 * and for `similarity()` ranking. Concatenated into a single expression so the
 * query carries ONE comparison instead of one per column, and so a single
 * trigram index can back it.
 */
export function foldedHaystack(alias: string, columns: string[]): string {
  return foldedTextExpression(
    columns
      .map((column) => coalesced(qualifyColumn(alias, column)))
      .join(" || ' ' || "),
  );
}

/**
 * The weighted, accent-folded `tsvector` for a row. Built field by field so
 * each column keeps its own weight, then concatenated with `||`, which is how
 * Postgres merges weighted vectors.
 */
export function weightedSearchVector(
  alias: string,
  fields: WeightedSearchField[],
): string {
  return fields
    .map(
      (field) =>
        `setweight(to_tsvector('${SEARCH_TEXT_CONFIG}', ` +
        `${foldedTextExpression(coalesced(qualifyColumn(alias, field.column)))}), '${field.weight}')`,
    )
    .join(' || ');
}

/**
 * The needle, folded exactly like the haystack. `websearch_to_tsquery` is what
 * a member already expects from a search box: bare words are ANDed, `"quoted
 * phrases"` stay adjacent, `or` and a leading `-` work, and — unlike
 * `to_tsquery` — malformed input never throws. `parameterName` is a bound
 * TypeORM parameter, so nothing member-typed is spliced into SQL.
 */
export function foldedSearchQuery(parameterName: string): string {
  return `websearch_to_tsquery('${SEARCH_TEXT_CONFIG}', ${foldedTextExpression(`:${parameterName}`)})`;
}

/** Folds a bound parameter for a `LIKE`/`similarity()` comparison. */
export function foldedSearchTerm(parameterName: string): string {
  return foldedTextExpression(`:${parameterName}`);
}

/**
 * Relevance score for a row: full-text rank first, then trigram similarity as
 * the tiebreaker that orders the substring-only hits among themselves (a hit
 * the `tsquery` missed scores 0 on `ts_rank`, so without this every one of
 * them would tie and fall straight through to the recency tiebreaker).
 *
 * Weighted 4:1 so a genuine token match always outranks a trigram near-miss.
 */
export function searchRankExpression(
  vectorSql: string,
  tsQuerySql: string,
  haystackSql: string,
  foldedTermSql: string,
): string {
  return (
    `(4 * ts_rank(${vectorSql}, ${tsQuerySql}) + ` +
    `similarity(${haystackSql}, ${foldedTermSql}))`
  );
}

// --- Per-table field lists ---------------------------------------------------
// These ARE the schema of the search indexes. See the ⚠️ note at the top.

/** `profiles` — name and handle rank above the headline, headline above the bio. */
export const PROFILE_SEARCH_FIELDS: WeightedSearchField[] = [
  { column: 'first_name', weight: 'A' },
  { column: 'last_name', weight: 'A' },
  { column: 'slug', weight: 'A' },
  { column: 'tagline', weight: 'B' },
  // Both bios: a Portuguese-speaking member writes their real self-description
  // in `bio_pt`, and leaving it out was half of why member search felt empty.
  { column: 'bio', weight: 'C' },
  { column: 'bio_pt', weight: 'C' },
];

export const PROFILE_SEARCH_COLUMNS = [
  'first_name',
  'last_name',
  'slug',
  'tagline',
  'bio',
  'bio_pt',
];

/** `forum_thread` — title, plus the tags that describe what it is about. */
export const FORUM_THREAD_SEARCH_FIELDS: WeightedSearchField[] = [
  { column: 'title', weight: 'A' },
];

export const FORUM_THREAD_SEARCH_COLUMNS = ['title'];

/**
 * `forum_post` — the reply bodies. Weight `B`: a thread's own title still wins
 * when both match, which is why a post hit and a thread hit are ranked in
 * separate queries and merged by type, never against each other.
 */
export const FORUM_POST_SEARCH_FIELDS: WeightedSearchField[] = [
  { column: 'body', weight: 'B' },
];

export const FORUM_POST_SEARCH_COLUMNS = ['body'];

// --- The same folding, in JavaScript -----------------------------------------

/**
 * Lowercase Latin-1 letters carrying a diacritic and their plain equivalents,
 * mirroring the pair `connection-search.ts` splices into `translate()`. Kept
 * here as well because a JS-side fold has to agree with the SQL one character
 * for character; `search-text.spec.ts` extracts the SQL pair from
 * `foldedTextExpression` and asserts they are identical, so they cannot drift.
 */
const ACCENTED_CHARACTERS = 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ';
const PLAIN_CHARACTERS = 'aaaaaaceeeeiiiinooooouuuuyy';

const FOLD_BY_CHARACTER = new Map(
  Array.from(ACCENTED_CHARACTERS, (accented, index) => [
    accented,
    PLAIN_CHARACTERS[index] ?? accented,
  ]),
);

/**
 * Folds a string exactly as the SQL side does: lowercase, then swap each
 * accented Latin-1 letter for its plain equivalent. One character in, one
 * character out, so an index into the folded string is also an index into the
 * original. That is what lets a search excerpt be centred on a match the
 * database found through the folded expression.
 */
export function foldSearchText(text: string): string {
  return Array.from(text.toLowerCase(), (character) => {
    const folded = FOLD_BY_CHARACTER.get(character);
    return folded === undefined ? character : folded;
  }).join('');
}

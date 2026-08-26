/**
 * CON-12 — turns a reader's raw search-box input into a `to_tsquery` string
 * for `magazine_article.search_vector`.
 *
 * WHY NOT `websearch_to_tsquery`
 * `websearch_to_tsquery` accepts any garbage safely and understands quoted
 * phrases, which is attractive, but it matches whole (stemmed) words only.
 * What this replaces in the global search box is `title ILIKE '%term%'`, which
 * matched partial words: someone searching "transi" got every headline
 * carrying "transition". Whole-word-only matching would take that away, so the
 * upgrade would read as a regression. Every token therefore gets Postgres's
 * `:*` prefix marker.
 *
 * The cost of that choice is quoted phrase search, which `websearch_to_tsquery`
 * would have given for free. Worth revisiting if readers ask for it.
 *
 * WHY THIS IS SAFE TO CONCATENATE
 * `to_tsquery` parses its argument as a query language, so `&`, `|`, `!`,
 * `(`, `)` and `:` in raw input are either a syntax error (a 500 on a typo) or
 * an operator the reader did not ask for. Splitting on everything that is not
 * a letter or a digit leaves tokens that cannot carry any of those, and the
 * result is still bound as a single parameter, never interpolated into SQL.
 * The tokens are AND-ed, so more words narrow the result the way a search box
 * is expected to behave.
 *
 * Returns `null` when the input holds nothing searchable (empty, whitespace,
 * or only punctuation). Callers must treat that as "no results", never as "no
 * filter" — dropping the predicate would answer a nonsense search with the
 * whole magazine.
 */

/** Beyond this, extra words only slow the query down; nobody searches with 9. */
const MAX_SEARCH_TOKENS = 8;

export function toPrefixTsQuery(term: string): string | null {
  const tokens = term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
    .slice(0, MAX_SEARCH_TOKENS);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `${token}:*`).join(' & ');
}

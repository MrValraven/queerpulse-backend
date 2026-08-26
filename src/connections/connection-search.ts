/**
 * Accent-insensitive matching for the connections list search (SOC-14).
 *
 * This audience writes Portuguese, so "Sao" has to find "São" and "ines" has to
 * find "Inês". Postgres `lower()` folds case but leaves diacritics alone, so a
 * plain `ILIKE '%sao%'` misses the person the member is actually looking for.
 *
 * `translate()` is used rather than the `unaccent` extension deliberately:
 *
 *  - it needs no `CREATE EXTENSION`, so nothing about this search depends on
 *    what the database role is allowed to install;
 *  - it is IMMUTABLE (`unaccent(text)` is only STABLE), so if this predicate
 *    ever gets hot an expression index over exactly this expression is a
 *    migration away, which `unaccent` could never be without a wrapper.
 *
 * It is deliberately NOT a shared search layer: the platform-wide search lives
 * in `src/search/**` and owns its own vocabulary. This is a local, bounded
 * filter over the connections the viewer already has.
 *
 * The predicate does NOT get an index here and does not need one: the search
 * is always ANDed onto a `connections` scan already restricted to the viewer's
 * own edges, so the text comparison runs over that member's connection degree,
 * never over `profiles` request-wide.
 */

// Lowercase Latin-1 letters that carry a diacritic, and their plain
// equivalents at the same position. `lower()` runs first, so the uppercase
// forms never reach `translate()`.
const ACCENTED_CHARACTERS = 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ';
const PLAIN_CHARACTERS = 'aaaaaaceeeeiiiinooooouuuuyy';

/**
 * Wrap a SQL text expression (a column, a concatenation, or a bound parameter
 * placeholder) in the case- and accent-folding used on BOTH sides of the
 * comparison, so the haystack and the needle are folded identically.
 *
 * Both character maps are compile-time constants, never member input, so
 * inlining them into the SQL string introduces nothing to inject.
 */
export function foldedTextExpression(sqlExpression: string): string {
  return `translate(lower(${sqlExpression}), '${ACCENTED_CHARACTERS}', '${PLAIN_CHARACTERS}')`;
}

/**
 * The single haystack a connection's search terms are matched against: the
 * other member's name, their handle (`slug`), and their headline (`tagline`).
 * Concatenated into one expression so the query carries ONE `LIKE` branch
 * instead of four OR'd ones.
 */
export const CONNECTION_SEARCH_HAYSTACK =
  "coalesce(other.first_name, '') || ' ' || " +
  "coalesce(other.last_name, '') || ' ' || " +
  "coalesce(other.slug, '') || ' ' || " +
  "coalesce(other.tagline, '')";

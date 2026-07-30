/**
 * Escape LIKE/ILIKE metacharacters (`\ % _`) so a user's raw search term is
 * matched literally inside a `%...%` pattern. Bind the result as a parameter —
 * this handles wildcards, not SQL injection.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

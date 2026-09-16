/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- `pg` ships no bundled .d.ts and this repo has no `@types/pg` devDependency (adding one needs a package.json change outside this fix's file allowlist), so `Client` resolves untyped here. Runtime behaviour is exercised directly against the live local database by every test in this file. */
import { Client } from 'pg';
import { escapeLikeTerm } from '../common/like-escape';
import { foldedTextExpression } from '../search/search-text';

/**
 * ENG-268: functional proof that `MessagesService.searchMessages`'s folded
 * `LIKE` comparison (`${foldedHaystack('m', ['body'])} LIKE
 * ${foldedSearchTerm('pattern')} ESCAPE '\'`) actually does what its doc
 * comment claims: an unaccented query finds accented text and the reverse,
 * case never matters, and `escapeLikeTerm`'s escaping still survives being
 * wrapped in the fold. `message-search-scoping.spec.ts` proves the query is
 * WIRED to this expression (via a mocked query builder); this spec proves the
 * expression itself is CORRECT, by running the exact SQL Postgres evaluates
 * against the live local database (`postgres://queerpulse:queerpulse@
 * localhost:5432/queerpulse`), reusing `foldedTextExpression` imported
 * straight from `search-text.ts`, the same helper `foldedHaystack` and
 * `foldedSearchTerm` are built on, and the same helper
 * `MessageAnnotationsService.listStarredMessages` already folds its own
 * search through. No table is read or written: both sides of the `LIKE` are
 * bound parameters, so this is a pure SQL-function check with nothing to
 * clean up afterward.
 */
describe('MessagesService.searchMessages text folding (ENG-268)', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({
      connectionString:
        process.env.DATABASE_URL ??
        'postgres://queerpulse:queerpulse@localhost:5432/queerpulse',
    });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  /**
   * Runs the IDENTICAL SQL shape `searchMessages` issues for its text match:
   * `foldedHaystack('m', ['body'])`'s expression (specialised here to one
   * bound haystack parameter instead of a real column, since no table is
   * involved) `LIKE` `foldedSearchTerm('pattern')`'s expression, `ESCAPE
   * '\'`. `bodyText` stands in for `m.body`; `rawQuery` is folded through the
   * exact same `escapeLikeTerm` + `%...%` wrap `searchMessages` itself
   * applies before binding.
   */
  async function foldedLikeMatches(
    bodyText: string,
    rawQuery: string,
  ): Promise<boolean> {
    const pattern = `%${escapeLikeTerm(rawQuery)}%`;
    const sql = `SELECT ${foldedTextExpression('$1::text')} LIKE ${foldedTextExpression('$2::text')} ESCAPE '\\' AS matches`;
    const { rows } = await client.query<{ matches: boolean }>(sql, [
      bodyText,
      pattern,
    ]);
    return rows[0]!.matches;
  }

  it('an unaccented query matches accented body text', async () => {
    await expect(
      foldedLikeMatches('Vamos tomar um café amanhã', 'cafe'),
    ).resolves.toBe(true);
  });

  it('an accented query matches unaccented body text', async () => {
    await expect(
      foldedLikeMatches("let's grab a cafe later", 'café'),
    ).resolves.toBe(true);
  });

  it('stays case-insensitive alongside the accent fold', async () => {
    await expect(foldedLikeMatches('CAFÉ con leche', 'cafe')).resolves.toBe(
      true,
    );
    await expect(foldedLikeMatches('cafe con leche', 'CAFÉ')).resolves.toBe(
      true,
    );
  });

  it('does not match unrelated text', async () => {
    await expect(
      foldedLikeMatches('brunch plans for saturday', 'cafe'),
    ).resolves.toBe(false);
  });

  it('still matches a literal %, kept literal by escapeLikeTerm rather than acting as a wildcard', async () => {
    await expect(
      foldedLikeMatches('Get 50% off today', '50% off'),
    ).resolves.toBe(true);
    // The escape keeps `%` literal, so a body missing the exact "50% off"
    // substring stays unmatched even though it fits the unescaped wildcard
    // shape.
    await expect(
      foldedLikeMatches('Get 50X off today', '50% off'),
    ).resolves.toBe(false);
  });

  it('still matches a literal _, kept literal by escapeLikeTerm rather than acting as a single-character wildcard', async () => {
    await expect(
      foldedLikeMatches('the file_name field', 'file_name'),
    ).resolves.toBe(true);
    await expect(
      foldedLikeMatches('the fileXname field', 'file_name'),
    ).resolves.toBe(false);
  });
});

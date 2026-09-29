import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GIN indexes on `profiles.profession` and `profiles.discipline`, the last two
 * unindexed arms of the member search OR group.
 *
 * `applyDirectoryFilters` (`profiles/member-directory.query.ts`) ORs two arms
 * into the search group alongside `memberSearchTextMatch` when the frontend
 * resolved the search words to catalog ids:
 * `p.profession && :memberSearchProfessions` and
 * `p.discipline && :memberSearchDisciplines`. Postgres can answer an OR with a
 * BitmapOr only when EVERY arm has an index path. The text arms have theirs
 * (`1795100000000-AddSearchTextIndexes` for open profiles,
 * `1824900000000-AddProfilePublicSearchIndexes` for the rest), but both
 * columns are plain `text[]`
 * (`1791000000000-AddProfileDisciplineProfessionLanguages`) and no earlier
 * migration indexes either. So whenever one of those arms is present the
 * whole predicate falls back to a sequential scan of `profiles`.
 *
 * A GIN over each array with the default `array_ops` supports `&&`, which
 * gives those arms their index path. The chip filters
 * (`p.profession && :professions`, `p.discipline && :disciplines`) use the
 * same operator and gain the same path. Both are full indexes: these arms
 * carry no visibility gate.
 *
 * This reverses the "No GIN index" decision recorded in
 * `1791000000000-AddProfileDisciplineProfessionLanguages` (inherited from
 * `1782800770000`): sparse, opt-in columns made a sequential scan the cheaper
 * plan. That trade-off was weighed for the chip filters, which are ANDed with
 * the rest of the WHERE, so the planner can drive the scan from any other
 * indexed clause and apply `&&` as a filter. The member search group ORs
 * these arms with the text branches, and under an OR a single arm with no
 * index path forces the whole group back to a sequential scan, which throws
 * away the text indexes on every search that resolved a profession or
 * discipline id. Sparse arrays also keep these GINs small and cheap to write.
 *
 * Kept in its own migration so it applies on a database that already ran
 * `1824900000000`.
 */
export class AddProfileProfessionDisciplineGinIndexes1824910000000 implements MigrationInterface {
  name = 'AddProfileProfessionDisciplineGinIndexes1824910000000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). No transactional DDL
  // lives in this file for that reason.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_profession_gin" ` +
        `ON "profiles" USING gin ("profession")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_discipline_gin" ` +
        `ON "profiles" USING gin ("discipline")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_profiles_discipline_gin"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_profiles_profession_gin"`,
    );
  }
}

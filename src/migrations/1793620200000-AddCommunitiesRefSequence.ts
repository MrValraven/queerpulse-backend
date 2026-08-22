import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces the `COUNT(*) + 1` community-ref allocator with a real Postgres
 * sequence (BE-COM-23).
 *
 * `CommunitiesService.createWithUniqueRef` built `ref = 'QP-C-' + pad(count +
 * 1)` inside the create transaction. Two concurrent creates read the same
 * count and collide on `UQ_communities_ref`; the retry loop then recomputed
 * the *same* count (the other transaction still being uncommitted) and burned
 * all five attempts. Worse, the counter is derived from live rows, so a single
 * hard-deleted community would make every future create collide with an
 * existing ref forever.
 *
 * A sequence has neither problem: `nextval` is concurrency-safe and never
 * hands the same number out twice, and it does not care how many rows exist.
 * The trade-off is gaps — a rolled-back create burns its number, since
 * sequence advancement is deliberately non-transactional. A ref is an opaque
 * human-quotable handle, not a count of communities, so a gap is harmless.
 *
 * `setval(..., false)` seeds the sequence so the NEXT `nextval` returns
 * `max(existing ref number) + 1`, keeping the series continuous with whatever
 * the old allocator already assigned. `substring(ref from 'QP-C-(\d+)')`
 * tolerates any row whose ref does not match the pattern (there are none, but
 * a non-matching row yields NULL and is ignored by `MAX`) rather than erroring
 * the migration.
 *
 * Plain transactional DDL — no `CONCURRENTLY` anywhere, so this migration
 * keeps the default transaction wrapping.
 */
export class AddCommunitiesRefSequence1793620200000 implements MigrationInterface {
  name = 'AddCommunitiesRefSequence1793620200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE "communities_ref_seq"`);
    await queryRunner.query(`
      SELECT setval(
        'communities_ref_seq',
        COALESCE(
          (SELECT MAX(substring("ref" from 'QP-C-(\\d+)')::bigint) FROM "communities"),
          0
        ) + 1,
        false
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE "communities_ref_seq"`);
  }
}

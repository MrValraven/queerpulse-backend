// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-250. Adds `housing_listings.deposit_euros`, the one renter-facing money
 * term the board never collected.
 *
 * Renters could already filter on type, area, price, beds, move-in, bills,
 * accessibility and verified status, but not on the deposit, which is often the
 * number that decides whether a home is reachable at all. Furnishing and pets
 * needed no column (listers have been ticking those as stored `features` chips
 * since launch and no filter ever read them); the deposit had nowhere to live.
 *
 * SHAPE: integer euros, mirroring `rent_euros`. Months-of-rent was considered
 * and rejected: it is only comparable once you also hold the rent, and listers
 * state deposits both ways.
 *
 * NULLABLE, NO DEFAULT, NO BACKFILL, and this is the load-bearing decision.
 * NULL means "not stated" and must never be read as zero. A `DEFAULT 0` would
 * silently tell renters that every pre-existing listing on the board has no
 * deposit, which is both false and the most expensive direction to be wrong in.
 * The filter spells the exclusion out (`deposit_euros IS NOT NULL AND <= :max`)
 * rather than relying on SQL's NULL semantics, and the in-memory twin used by
 * the saved-search alert fan-out mirrors it exactly.
 *
 * NO INDEX, and this is a considered no rather than an omission. A range index
 * on `deposit_euros` would fight the `created_at DESC` ordering that
 * `IDX_housing_listings_status_created_at` already serves, and the predicate
 * runs as a per-row filter over an already-narrow single-city live set. The
 * `features` filters get no GIN index either: GIN array opclasses serve
 * containment (`features @> ARRAY['Furnished']`), while the query is
 * `lower(btrim(element)) = const` under an `unnest`, which no array opclass
 * covers. A GIN would be unusable by the query that exists, so proposing one
 * would be a speculative index that could never be hit.
 */
export class AddHousingListingDepositEuros1817030000000
  implements MigrationInterface
{
  name = 'AddHousingListingDepositEuros1817030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD COLUMN IF NOT EXISTS "deposit_euros" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN IF EXISTS "deposit_euros"`,
    );
  }
}

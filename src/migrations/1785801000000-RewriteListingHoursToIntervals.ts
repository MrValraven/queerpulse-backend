import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Item #6 — migrates the stored `listings.hours` jsonb from the old flat
 * per-day shape `{ open, from, to }` to the split-interval shape
 * `{ open, intervals: { from, to }[] }` (see
 * `listings/entities/listing.entity.ts#ListingDayHours`). The `hours` column is
 * a jsonb map keyed by weekday id (`Mon`..`Sun`); each day's value is rewritten
 * in place:
 *
 *   - an OPEN day with a `from`/`to` becomes `{ open: true, intervals:
 *     [{ from, to }] }`;
 *   - a closed day (or an open day with no times) becomes `{ open, intervals:
 *     [] }`.
 *
 * The transform is IDEMPOTENT: a day whose value already carries an `intervals`
 * key is passed through untouched, so re-running the migration (or running it
 * over a partially-migrated table) is safe. Rows with an empty `hours` (`'{}'`)
 * are skipped entirely.
 *
 * Plain transactional DML (no `CREATE INDEX CONCURRENTLY` here), so this runs
 * inside the default migration transaction — no `transaction = false` opt-out.
 */
export class RewriteListingHoursToIntervals1785801000000 implements MigrationInterface {
  name = 'RewriteListingHoursToIntervals1785801000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "listings"
      SET "hours" = COALESCE(
        (
          SELECT jsonb_object_agg(
            day_key,
            CASE
              -- Already the new shape → leave it (idempotent re-run guard).
              WHEN day_val ? 'intervals' THEN day_val
              -- Open day with a real time span → one interval.
              WHEN COALESCE((day_val->>'open')::boolean, false)
                   AND (
                     COALESCE(day_val->>'from', '') <> ''
                     OR COALESCE(day_val->>'to', '') <> ''
                   )
                THEN jsonb_build_object(
                  'open', true,
                  'intervals', jsonb_build_array(
                    jsonb_build_object(
                      'from', COALESCE(day_val->>'from', ''),
                      'to', COALESCE(day_val->>'to', '')
                    )
                  )
                )
              -- Closed day, or open with no times → no intervals.
              ELSE jsonb_build_object(
                'open', COALESCE((day_val->>'open')::boolean, false),
                'intervals', '[]'::jsonb
              )
            END
          )
          FROM jsonb_each("hours") AS entries(day_key, day_val)
        ),
        '{}'::jsonb
      )
      WHERE "hours" IS NOT NULL AND "hours" <> '{}'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort reverse: collapse each day back to `{ open, from, to }` using
    // the FIRST interval. A day with two intervals (a split the old shape can't
    // represent) necessarily loses its second interval — documented, and the
    // only faithful reverse the flat shape allows.
    await queryRunner.query(`
      UPDATE "listings"
      SET "hours" = COALESCE(
        (
          SELECT jsonb_object_agg(
            day_key,
            CASE
              -- Not the new shape → leave it (nothing to collapse).
              WHEN NOT (day_val ? 'intervals') THEN day_val
              WHEN COALESCE((day_val->>'open')::boolean, false)
                   AND jsonb_array_length(
                     COALESCE(day_val->'intervals', '[]'::jsonb)
                   ) >= 1
                THEN jsonb_build_object(
                  'open', true,
                  'from', COALESCE(day_val->'intervals'->0->>'from', ''),
                  'to', COALESCE(day_val->'intervals'->0->>'to', '')
                )
              ELSE jsonb_build_object(
                'open', COALESCE((day_val->>'open')::boolean, false),
                'from', '',
                'to', ''
              )
            END
          )
          FROM jsonb_each("hours") AS entries(day_key, day_val)
        ),
        '{}'::jsonb
      )
      WHERE "hours" IS NOT NULL AND "hours" <> '{}'::jsonb
    `);
  }
}

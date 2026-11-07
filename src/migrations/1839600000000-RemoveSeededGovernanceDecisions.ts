// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Takes the invented decision log off the public Governance page.
 *
 * `SeedGovernanceContent1788600000000` stored four key-backed entries in the
 * `decisions` column of the `governance_overview` singleton: a May 2026 sliding
 * scale, an April 2026 forum launch, a March 2026 visibility default and a
 * February 2026 language toggle, each credited to "the council" (whose seats
 * are still being appointed). `RemoveSeededGovernanceFinances1828700000000`
 * kept them on purpose; the owner has since ruled that nothing invented may
 * appear on a public page, so they go too.
 *
 * Only the four seeded entries are removed, matched by their short i18n key
 * (`slidingScale`, `forumLaunched`, `visibilityDefaults`, `languageToggle`).
 * An entry a governance editor authored through the Policy tab carries `lead`
 * and `body` instead of a `key`, so it is never matched and survives in its
 * stored order. Re-running finds no seeded key left and changes nothing.
 *
 * The seed values are written out here on purpose, for the same reason
 * `RemoveSeededGovernanceFinances1828700000000` does it: importing them from
 * `governance-overview.seed.ts` would tie this migration to whatever that dev
 * fixture says on the day it runs.
 */

/** The short keys `governanceOverviewSeed.decisions` used to hold. */
const SEEDED_DECISION_KEYS = [
  'slidingScale',
  'forumLaunched',
  'visibilityDefaults',
  'languageToggle',
];

export class RemoveSeededGovernanceDecisions1839600000000 implements MigrationInterface {
  name = 'RemoveSeededGovernanceDecisions1839600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `WITH ORDINALITY` keeps the surviving entries in their stored order. An
    // entry without a `key` (authored form) reads as '' and is kept. The outer
    // EXISTS makes the UPDATE a no-op on a row with no seeded entry, so
    // `updated_at` is not touched on a second run.
    await queryRunner.query(
      `UPDATE "governance_overview"
          SET "decisions" = (
            SELECT COALESCE(
              jsonb_agg(entry.decision ORDER BY entry.position),
              '[]'::jsonb
            )
            FROM jsonb_array_elements("decisions")
              WITH ORDINALITY AS entry(decision, position)
            WHERE COALESCE(entry.decision->>'key', '') <> ALL($1::text[])
          )
        WHERE "id" = 'current'
          AND jsonb_typeof("decisions") = 'array'
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements("decisions") AS seeded(decision)
             WHERE COALESCE(seeded.decision->>'key', '') = ANY($1::text[])
          )`,
      [SEEDED_DECISION_KEYS],
    );
  }

  public async down(): Promise<void> {
    // Deliberately a no-op. Putting the four entries back would republish
    // decisions that never happened on a public accountability page, which is
    // the bug `up` fixes.
  }
}

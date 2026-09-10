// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives a gathering a FAMILY and a per-family details bag, and rewrites the
 * eight labels the old wizard could store into the new format vocabulary.
 *
 * THE PROBLEM. `events.event_type` held one of eight free strings that nothing
 * downstream read: no card showed it, the browse filter narrowed on a value
 * attendees never saw, and "Other" was stored as the literal word, so every
 * unusual gathering was indistinguishable from every other one.
 *
 * WHAT LANDS HERE. `gathering_family` (a nine-value enum, nullable) and
 * `format_details` (jsonb, nullable). `event_type` is untouched structurally
 * and now holds a curated format key or the host's own text.
 *
 * THE BACKFILL is the eight known labels and nothing else, matched
 * case-insensitively. Any other stored value keeps its text and stays without
 * a family: guessing a family for a string a host typed themselves would put
 * a gathering under a facet its host never chose. "Other" clears both columns,
 * since the literal word said nothing about the gathering.
 *
 * TRANSACTIONAL, unlike the `ALTER TYPE ... ADD VALUE` migrations here: this
 * one CREATEs a fresh type rather than extending a committed one, so the type,
 * the columns, the backfill and the index all land or none of them do. The
 * index is a plain `CREATE INDEX`, matching `IDX_events_event_type`
 * (1794701000000), because `CONCURRENTLY` cannot run inside a transaction.
 */
export class AddGatheringFamilyAndFormatDetails1817080000000 implements MigrationInterface {
  name = 'AddGatheringFamilyAndFormatDetails1817080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "events_gathering_family_enum" AS ENUM('meet', 'eat', 'party', 'make', 'learn', 'watch', 'move', 'care', 'organise')`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" ADD COLUMN "gathering_family" "events_gathering_family_enum", ADD COLUMN "format_details" jsonb`,
    );

    // The eight labels the old wizard could store, verbatim from the spec's
    // backfill table. Case-insensitive because the column is free text and a
    // hand-edited row may differ in case from what the picker wrote.
    const backfill: {
      legacyLabel: string;
      family: string;
      formatKey: string;
    }[] = [
      { legacyLabel: 'Supper club', family: 'eat', formatKey: 'supper-club' },
      {
        legacyLabel: 'Workshop / talk',
        family: 'learn',
        formatKey: 'workshop',
      },
      { legacyLabel: 'Screening', family: 'watch', formatKey: 'screening' },
      {
        legacyLabel: 'Studio visit',
        family: 'make',
        formatKey: 'studio-visit',
      },
      {
        legacyLabel: 'Walk or outdoor',
        family: 'move',
        formatKey: 'walk-or-hike',
      },
      { legacyLabel: 'Discussion', family: 'learn', formatKey: 'discussion' },
      {
        legacyLabel: 'Skills exchange',
        family: 'learn',
        formatKey: 'skills-exchange',
      },
    ];
    for (const row of backfill) {
      await queryRunner.query(
        `UPDATE "events"
           SET "gathering_family" = $1::"events_gathering_family_enum",
               "event_type" = $2
         WHERE lower("event_type") = lower($3)`,
        [row.family, row.formatKey, row.legacyLabel],
      );
    }

    // "Other" told nobody anything. Clear the column rather than keep a word
    // that reads as a category on a card.
    await queryRunner.query(
      `UPDATE "events" SET "event_type" = NULL WHERE lower("event_type") = lower($1)`,
      ['Other'],
    );

    // The family is the browse board's primary facet, and browse only ever
    // reads published rows, so the index is partial the same way
    // `IDX_events_event_type` and `IDX_events_neighbourhood` are.
    await queryRunner.query(`
      CREATE INDEX "IDX_events_gathering_family"
        ON "events" ("gathering_family")
        WHERE "status" = 'published'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_events_gathering_family"`);

    // Put the eight labels back BEFORE the family column goes, and only on
    // rows whose family still matches what the backfill set. A gathering
    // created after this migration under the new vocabulary keeps its format
    // key, since its family will not line up with the pair being reversed.
    const reverse: {
      legacyLabel: string;
      family: string;
      formatKey: string;
    }[] = [
      { legacyLabel: 'Supper club', family: 'eat', formatKey: 'supper-club' },
      {
        legacyLabel: 'Workshop / talk',
        family: 'learn',
        formatKey: 'workshop',
      },
      { legacyLabel: 'Screening', family: 'watch', formatKey: 'screening' },
      {
        legacyLabel: 'Studio visit',
        family: 'make',
        formatKey: 'studio-visit',
      },
      {
        legacyLabel: 'Walk or outdoor',
        family: 'move',
        formatKey: 'walk-or-hike',
      },
      { legacyLabel: 'Discussion', family: 'learn', formatKey: 'discussion' },
      {
        legacyLabel: 'Skills exchange',
        family: 'learn',
        formatKey: 'skills-exchange',
      },
    ];
    for (const row of reverse) {
      await queryRunner.query(
        `UPDATE "events"
           SET "event_type" = $1
         WHERE "event_type" = $2
           AND "gathering_family" = $3::"events_gathering_family_enum"`,
        [row.legacyLabel, row.formatKey, row.family],
      );
    }

    await queryRunner.query(
      `ALTER TABLE "events" DROP COLUMN "format_details", DROP COLUMN "gathering_family"`,
    );
    await queryRunner.query(`DROP TYPE "events_gathering_family_enum"`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts `profiles.open_to` from a flat `text[]` of free-form strings into a
 * `jsonb` array of OpenToEntry objects (see src/profiles/open-to.ts), and caps
 * `profiles.now` at 280 characters.
 *
 * Existing values are matched case-insensitively against an alias map onto the
 * nine shared preset ids; anything unmatched becomes a custom entry carrying
 * the member's original wording verbatim, so nobody loses words they wrote.
 * ('Hiring', for instance, has no preset and survives as a custom.)
 *
 * The backfill also de-duplicates (presets by id, customs case-insensitively)
 * and truncates to 12 entries, matching the write-side rules. Without the
 * truncation a legacy row of 13+ entries would round-trip back as a 400 and
 * block the member from saving ANY profile field. Legacy custom labels are
 * likewise truncated to 60 characters, matching the write-side DTO's max
 * label length, for the same reason.
 *
 * NOTE: down() restores the text[] shape but CANNOT restore `now` values that
 * up() truncated. That loss is one-way.
 */
export class AddOpenToEntries1782800680000 implements MigrationInterface {
  name = 'AddOpenToEntries1782800680000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "profiles"
      ADD "open_to_entries" jsonb NOT NULL DEFAULT '[]'::jsonb
    `);

    await queryRunner.query(`
      WITH exploded AS (
        SELECT
          p."user_id" AS user_id,
          u.ord       AS ord,
          CASE
            WHEN m.preset_id IS NOT NULL
              THEN jsonb_build_object('kind', 'preset', 'id', m.preset_id)
            ELSE jsonb_build_object('kind', 'custom', 'label', left(btrim(u.elem), 60))
          END AS entry,
          CASE
            WHEN m.preset_id IS NOT NULL THEN 'preset:' || m.preset_id
            ELSE 'custom:' || lower(left(btrim(u.elem), 60))
          END AS dedupe_key
        FROM "profiles" p
        CROSS JOIN LATERAL unnest(p."open_to") WITH ORDINALITY AS u(elem, ord)
        LEFT JOIN (VALUES
          ('collaborating',  'collaborating'),
          ('collaboration',  'collaborating'),
          ('collaborations', 'collaborating'),
          ('mentoring',      'mentoring'),
          ('mentorship',     'mentoring'),
          ('casual meetups', 'casualMeetups'),
          ('casualmeetups',  'casualMeetups'),
          ('commissions',    'commissions'),
          ('commission',     'commissions'),
          ('client work',    'clientWork'),
          ('clientwork',     'clientWork'),
          ('referrals',      'referrals'),
          ('referral',       'referrals'),
          ('swaps',          'swaps'),
          ('swap',           'swaps'),
          ('studio visits',  'studioVisits'),
          ('studiovisits',   'studioVisits'),
          ('interviewees',   'interviewees'),
          ('interviewee',    'interviewees')
        ) AS m(alias, preset_id) ON m.alias = lower(btrim(u.elem))
        WHERE btrim(u.elem) <> ''
      ),
      deduped AS (
        SELECT DISTINCT ON (user_id, dedupe_key) user_id, ord, entry
        FROM exploded
        ORDER BY user_id, dedupe_key, ord
      ),
      ranked AS (
        SELECT
          user_id,
          ord,
          entry,
          row_number() OVER (PARTITION BY user_id ORDER BY ord) AS rn
        FROM deduped
      ),
      agg AS (
        SELECT user_id, jsonb_agg(entry ORDER BY ord) AS entries
        FROM ranked
        WHERE rn <= 12
        GROUP BY user_id
      )
      UPDATE "profiles" p
      SET "open_to_entries" = agg.entries
      FROM agg
      WHERE p."user_id" = agg.user_id
    `);

    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "open_to"`);
    await queryRunner.query(`
      ALTER TABLE "profiles" RENAME COLUMN "open_to_entries" TO "open_to"
    `);

    await queryRunner.query(`
      UPDATE "profiles"
      SET "now" = left("now", 280)
      WHERE "now" IS NOT NULL AND char_length("now") > 280
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "profiles"
      ADD "open_to_text" text array NOT NULL DEFAULT '{}'
    `);

    await queryRunner.query(`
      WITH exploded AS (
        SELECT
          p."user_id" AS user_id,
          e.ord       AS ord,
          CASE
            WHEN e.entry->>'kind' = 'preset'
              THEN COALESCE(m.label, e.entry->>'id')
            ELSE e.entry->>'label'
          END AS value
        FROM "profiles" p
        CROSS JOIN LATERAL jsonb_array_elements(p."open_to")
          WITH ORDINALITY AS e(entry, ord)
        LEFT JOIN (VALUES
          ('collaborating', 'Collaborating'),
          ('mentoring',     'Mentoring'),
          ('casualMeetups', 'Casual meetups'),
          ('commissions',   'Commissions'),
          ('clientWork',    'Client work'),
          ('referrals',     'Referrals'),
          ('swaps',         'Swaps'),
          ('studioVisits',  'Studio visits'),
          ('interviewees',  'Interviewees')
        ) AS m(preset_id, label) ON m.preset_id = e.entry->>'id'
      ),
      agg AS (
        SELECT user_id, array_agg(value ORDER BY ord) AS values
        FROM exploded
        WHERE value IS NOT NULL AND value <> ''
        GROUP BY user_id
      )
      UPDATE "profiles" p
      SET "open_to_text" = agg.values
      FROM agg
      WHERE p."user_id" = agg.user_id
    `);

    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "open_to"`);
    await queryRunner.query(`
      ALTER TABLE "profiles" RENAME COLUMN "open_to_text" TO "open_to"
    `);
  }
}

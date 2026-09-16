// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-364/PRD-366: four additive columns on `member_preferences` for the new
 * messaging-privacy pane.
 *
 * `share_read_receipts` / `share_typing` / `share_presence` all default TRUE
 * (PRD-364: sharing is on until a member says otherwise, and each is
 * RECIPROCAL — turning one off also stops that member from seeing the same
 * signal from everyone else; see `PreferencesService.getMessagingPrivacy`'s
 * own doc and `ChatGateway`'s presence/typing/read-relay gates). An absent
 * row (a member who never opened Settings) must read identically to an
 * explicit all-true row, which is why the column defaults mirror
 * `PreferencesService.defaults()` rather than requiring a synthesised
 * fallback that could drift from them.
 *
 * `who_can_message` (PRD-366; enforced at send/request time by
 * `ConnectionsService.resolveRequestGate`, layered on top of
 * `profiles.visibility`, the stricter of the two winning — see
 * `who-can-message.ts`) defaults to `'everyone'`, the platform's existing
 * behaviour before this column existed, so no backfill is needed. It is a
 * plain `varchar(16)` with a
 * CHECK rather than a fourth Postgres enum type on this entity: a
 * three-value closed set that may plausibly grow (a `network`-tier choice is
 * a foreseeable follow-up) is one `ALTER TABLE ... DROP CONSTRAINT` +
 * `ADD CONSTRAINT` away from widening, where a Postgres enum would need
 * `ALTER TYPE ... ADD VALUE` and the "keeps the default transaction open"
 * caveat that comes with it.
 *
 * A single plain `ALTER TABLE ADD COLUMN` batch against an existing table —
 * no new index, no backfill (every default is a literal, not derived from
 * other rows) — plus the CHECK constraint as a second statement so a
 * `down()` can drop it explicitly before dropping the column it constrains.
 */
export class AddMessagingPrivacyPreferences1820500000000 implements MigrationInterface {
  name = 'AddMessagingPrivacyPreferences1820500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        ADD COLUMN "share_read_receipts" boolean NOT NULL DEFAULT true,
        ADD COLUMN "share_typing" boolean NOT NULL DEFAULT true,
        ADD COLUMN "share_presence" boolean NOT NULL DEFAULT true,
        ADD COLUMN "who_can_message" varchar(16) NOT NULL DEFAULT 'everyone'
    `);
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        ADD CONSTRAINT "CHK_member_preferences_who_can_message"
        CHECK ("who_can_message" IN ('everyone', 'introduced', 'connections'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        DROP CONSTRAINT "CHK_member_preferences_who_can_message"
    `);
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        DROP COLUMN "share_read_receipts",
        DROP COLUMN "share_typing",
        DROP COLUMN "share_presence",
        DROP COLUMN "who_can_message"
    `);
  }
}

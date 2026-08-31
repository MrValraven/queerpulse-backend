import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SUS-07: let a member renew their own card, and warn them before it expires.
 *
 * Until now a card expired on the programme's `validity_months` clock and
 * nothing said so. The only route back in date was a community owner
 * remembering to run the roster bulk issue, which re-issues everyone at once,
 * so a member whose card had expired could not ask for a new one and found out
 * it was dead standing at a door.
 *
 * 1. `community_cards.allows_self_renew`. The issuing community's switch. NOT
 *    NULL DEFAULT false, so every programme that exists today keeps exactly the
 *    behaviour it has: nothing starts renewing itself because the platform
 *    shipped a feature. It matches the default on `allows_member_photo` and
 *    `allows_pronouns` for the same reason. Turning it on says "staying on our
 *    roster is the only condition", which is what
 *    `MembershipCardsService.renewOwnCard` then checks live on every renewal.
 *    A suspended or revoked card is never reachable through it: an issuer
 *    withdrew that one on purpose.
 *
 * 2. `membership_cards.expiry_warning_sent_at`. The marker that stops the
 *    warning repeating. `CardExpiryWarningService` is a DAILY cron and the
 *    window is thirty days wide, so without this column every member inside the
 *    window would be told again every morning for a month. Nullable, stamped by
 *    a conditional UPDATE that only moves a row whose marker is still NULL,
 *    exactly the way `deletion_request.final_warning_sent_at` solves the
 *    identical problem, so two replicas ticking together cannot double-send.
 *    Every path that puts a card back in date clears it, because the next term
 *    earns its own warning.
 *
 * 3. `IDX_membership_cards_expires_at`. That sweep asks for the cards falling
 *    due inside the next thirty days, which without an index is a full scan
 *    every night of a table that grows with (members x card programmes). A
 *    plain `CREATE INDEX`, deliberately not `CONCURRENTLY`: concurrent index
 *    builds cannot run inside a transaction and would force this into the
 *    two-phase runbook, and the table is small enough that the brief SHARE lock
 *    costs less than splitting the change in two.
 *
 * 4. `card_expiring` on `notifications_type_enum`. The in-app bell the warning
 *    is delivered on. QueerPulse sends no email, so that is the whole delivery
 *    story and no copy anywhere claims otherwise.
 *
 * TRANSACTIONAL, like `AddIntakeAndDsarNotificationTypes1794660000000` and for
 * the same reason: the rule the `transaction = false` enum migrations opt out
 * for is that a new enum label may not be USED in the transaction that added
 * it. Nothing here uses one. The two columns are on `community_cards` and
 * `membership_cards` and have no relationship to `notifications_type_enum`, so
 * PostgreSQL 12+ runs every statement together safely.
 *
 * `IF NOT EXISTS` on the `ADD VALUE` is the standing idiom for enum labels
 * here. The columns and the index are added unguarded, per CLAUDE.md: an
 * "already exists" failure there is real schema drift and should be diagnosed
 * with `migration:show` rather than silenced.
 */
export class AddCardSelfRenewAndExpiryWarning1795620000000 implements MigrationInterface {
  name = 'AddCardSelfRenewAndExpiryWarning1795620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_cards" ADD COLUMN "allows_self_renew" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "membership_cards" ADD COLUMN "expiry_warning_sent_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_membership_cards_expires_at" ON "membership_cards" ("expires_at")`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'card_expiring'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverts the three halves that CAN be reverted, and does not pretend about
    // the fourth. Dropping the index and both columns is a real undo; Postgres
    // cannot drop an enum label, and `card_expiring` is inert once nothing
    // writes it (the emit site reverts with the code, not with the schema).
    //
    // This deliberately does NOT throw the way the pure `ADD VALUE` migrations
    // here do. Those throw because a silent no-op would delete their ledger row
    // while leaving the label in place; this one has real work to undo, and
    // re-running `up()` afterwards succeeds because the columns and the index
    // are genuinely gone and the `ADD VALUE` carries `IF NOT EXISTS`.
    await queryRunner.query(`DROP INDEX "IDX_membership_cards_expires_at"`);
    await queryRunner.query(
      `ALTER TABLE "membership_cards" DROP COLUMN "expiry_warning_sent_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_cards" DROP COLUMN "allows_self_renew"`,
    );
  }
}

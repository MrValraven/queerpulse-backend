// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `group_added`, the `notifications_type_enum` value behind "you were added to
 * a group" (PRD-334).
 *
 * WHY IT EXISTS. A group owner or admin can put a member into a group
 * conversation, at creation or later through "Add members". Until this value
 * the only trace was the group quietly appearing in the member's inbox: no bell
 * row and no push said somebody had put them in a room with other people.
 * QueerPulse sends no email, so the bell and the push are the entire channel.
 *
 * WHAT IS WRITTEN UNDER IT. One row per added member, written by
 * `GroupNotificationsListener` on `GROUP_MEMBERS_ADDED`, which `GroupsService`
 * emits after the membership has committed. The adder is the actor, so a
 * recipient who blocked or muted them gets no row. It sits behind the
 * `new_messages` preference category.
 *
 * IN-APP AND PUSH ONLY. Nothing about this type may be described as an email.
 *
 * TRANSACTIONAL. Nothing in this file USES the new label, so the default
 * wrapping transaction is safe: `ALTER TYPE ... ADD VALUE` only has to be
 * committed before a statement reads or writes the label, and none here does.
 * `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddGroupAddedNotificationType1818700000000 implements MigrationInterface {
  name = 'AddGroupAddedNotificationType1818700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'group_added'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added label
    // is inert once nothing writes it. Fails loudly rather than reporting a
    // successful revert that undid nothing, which would drop the ledger row
    // and make the next `migration:run` error on a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}

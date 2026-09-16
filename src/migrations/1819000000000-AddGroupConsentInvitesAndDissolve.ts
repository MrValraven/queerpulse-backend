// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Messaging scan section 8 (Groups): consent-gated adds, a revocable invite
 * link, and dissolve.
 *
 * PRD-353. Being seated in a group used to be unconditional the instant an
 * owner/admin who is your connection typed your name: no invite, no accept, no
 * way to say no in advance. `member_preferences.group_add_policy` is the
 * member's own standing answer to "who may put me straight into a group",
 * either `connections` (default, today's behaviour) or `invite_only` (every
 * add from then on becomes a `group_invites` row the member accepts or
 * declines). A member who previously LEFT or was REMOVED from a given group is
 * never silently re-seated by a later add either, whatever their preference:
 * that case always creates an invite too (enforced in the service layer, not
 * here).
 *
 * PRD-358. `conversations.description` is the group's about text (max 500,
 * enforced at the DTO). `conversations.invite_token` is a revocable,
 * rotatable join-by-link token, nullable (no active link), unique while set,
 * NULL again the instant it is disabled or rotated away from. No QR code: the
 * token itself is the whole feature, rendered as a copyable/shareable link.
 *
 * PRD-357. `conversations.dissolved_at` marks a group ended by its owner (or by
 * the last leaver when no successor remains), read-only from that instant on,
 * enforced in the service layer. Kept as a column on `conversations` rather
 * than inferred from "zero active participants" so a dissolved group's history
 * stays legible even if every row is later cleaned up, and so the read path
 * never has to COUNT participants just to answer "is this group over".
 *
 * `conversation_participants.removed_by` records who removed a member (their
 * FK'd `user_id`), NULL on a voluntary leave, `ON DELETE SET NULL` so a
 * remover who later erases their account leaves no dangling reference. That
 * SET NULL is also why removal alone cannot be the durable record: once the
 * remover's account is gone, `removed_by` reads back as if the member had
 * left voluntarily. `removed_at` is the durable, FK-free timestamp counted
 * ONLY on a removal (never a voluntary leave, where it stays NULL), so the
 * severed-notice copy (DES-227/228) and the removed-from-group gate on a
 * join-by-link keep reading "removed" regardless of what later happens to
 * the remover's own account. Both columns are set together by `removeMember`
 * and cleared together on re-seat, per the service layer's contract; this
 * migration only adds the columns.
 *
 * `group_invites` is the new table `member_preferences.group_add_policy` and
 * PRD-358's invite/accept flow both write to: one row per (conversation,
 * invitee) offer, `status` walking `pending -> accepted|declined|revoked`. The
 * partial unique index on `(conversation_id, invitee_id) WHERE status =
 * 'pending'` is the idempotency guard: re-inviting someone who already has an
 * open invite must not create a second one, while a past
 * accepted/declined/revoked row is left in place as history and a fresh
 * pending invite is allowed to follow it. `(invitee_id, status)` backs "my
 * pending invites" (`GET /group-invites`).
 *
 * Two Postgres enum labels are appended for the same feature: `group_invite`
 * on `notifications_type_enum` (the bell/push for "you were invited to a
 * group", mirroring `group_added`'s own `AddGroupAddedNotificationType`), and
 * `conversation` on `reports_subject_type_enum` (PRD-356: reporting a group as
 * a whole, resolved by `ReportSubjectResolverService` to its current owner,
 * fallback `created_by`, with the group's title as the excerpt).
 *
 * TRANSACTIONAL for the same reason `AddGovernanceMemberMotions` states: on
 * Postgres 12+, `ALTER TYPE ... ADD VALUE` is only barred from the wrapping
 * transaction when a statement in that SAME transaction USES the new label.
 * Nothing here does: every other statement is column/table/index/constraint
 * DDL, so both `ADD VALUE` calls are safe inside the migration's default
 * transaction, and `IF NOT EXISTS` keeps them re-run-safe regardless.
 */
export class AddGroupConsentInvitesAndDissolve1819000000000 implements MigrationInterface {
  name = 'AddGroupConsentInvitesAndDissolve1819000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- PRD-353: consent preference -----------------------------------------
    await queryRunner.query(
      `CREATE TYPE "member_preferences_group_add_policy_enum" AS ENUM('connections', 'invite_only')`,
    );
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        ADD "group_add_policy" "member_preferences_group_add_policy_enum" NOT NULL DEFAULT 'connections'
    `);

    // --- PRD-358: description + revocable invite link ------------------------
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "description" character varying(500)`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "invite_token" character varying(64)`,
    );
    // Partial + unique: at most one conversation may hold a given token, and
    // most rows have no active link at all (NULL), so a full index would be
    // dead weight on every group that never turns link-join on.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_conversations_invite_token" ON "conversations" ("invite_token") WHERE "invite_token" IS NOT NULL`,
    );

    // --- PRD-357: dissolve -----------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "dissolved_at" TIMESTAMP WITH TIME ZONE`,
    );

    // --- Who removed a member (severed-notice copy, DES-227/228) -------------
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" ADD "removed_by" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversation_participants" ADD CONSTRAINT "FK_conversation_participants_removed_by"
        FOREIGN KEY ("removed_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    // Durable companion to `removed_by`: no FK, so the remover's own account
    // being deleted later can never null this back out and un-remove the
    // member. NULL on a voluntary leave, exactly like `removed_by`.
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" ADD "removed_at" TIMESTAMP WITH TIME ZONE`,
    );

    // --- group_invites -----------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "group_invites_status_enum" AS ENUM('pending', 'accepted', 'declined', 'revoked')`,
    );
    await queryRunner.query(`
      CREATE TABLE "group_invites" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "conversation_id" uuid NOT NULL,
        "invitee_id" uuid NOT NULL,
        "inviter_id" uuid,
        "status" "group_invites_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "responded_at" timestamptz,
        CONSTRAINT "PK_group_invites" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "group_invites" ADD CONSTRAINT "FK_group_invites_conversation_id"
        FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "group_invites" ADD CONSTRAINT "FK_group_invites_invitee_id"
        FOREIGN KEY ("invitee_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "group_invites" ADD CONSTRAINT "FK_group_invites_inviter_id"
        FOREIGN KEY ("inviter_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    // Idempotency guard: at most one OPEN invite per (conversation, invitee).
    // Partial on `status = 'pending'` so a past accepted/declined/revoked row
    // never blocks a fresh invite from following it.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_group_invites_conversation_invitee_pending" ON "group_invites" ("conversation_id", "invitee_id") WHERE "status" = 'pending'`,
    );
    // "My pending invites" (`GET /group-invites`).
    await queryRunner.query(
      `CREATE INDEX "IDX_group_invites_invitee_id_status" ON "group_invites" ("invitee_id", "status")`,
    );

    // --- New enum labels -------------------------------------------------------
    // Added, never used below. See the transaction note in the class doc.
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'group_invite'`,
    );
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE IF NOT EXISTS 'conversation'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible, same reasoning as `AddGroupAddedNotificationType`:
    // Postgres cannot drop an enum value, so the `group_invite`/`conversation`
    // labels this migration added to `notifications_type_enum`/
    // `reports_subject_type_enum` are permanent once `up()` has run. Fails
    // loudly, first, rather than running every other statement below and only
    // then discovering the enum labels block a clean revert: a partially
    // undone migration is worse than one that refuses outright, and a
    // successful-looking revert would drop the ledger row while these two
    // labels quietly stayed behind, corrupting the next `migration:run`.
    //
    // A manual revert (restore from backup instead, ideally) would otherwise
    // need to, in order:
    //  - `DROP INDEX "IDX_group_invites_invitee_id_status"`
    //  - `DROP INDEX "UQ_group_invites_conversation_invitee_pending"`
    //  - drop `group_invites`' three FKs, then `DROP TABLE "group_invites"`
    //    and `DROP TYPE "group_invites_status_enum"`
    //  - drop `conversation_participants`' `FK_conversation_participants_removed_by`,
    //    then `ALTER TABLE "conversation_participants" DROP COLUMN "removed_by"`
    //    and `DROP COLUMN "removed_at"`
    //  - `ALTER TABLE "conversations" DROP COLUMN "dissolved_at"`
    //  - `DROP INDEX "UQ_conversations_invite_token"`, then drop
    //    `conversations.invite_token` and `conversations.description`
    //  - `ALTER TABLE "member_preferences" DROP COLUMN "group_add_policy"`,
    //    then `DROP TYPE "member_preferences_group_add_policy_enum"`
    //  - rebuild `notifications_type_enum`/`reports_subject_type_enum` without
    //    `group_invite`/`conversation` via the rename-and-recreate dance (see
    //    `RemovePendingStatus1782800740000`), plus a real data decision about
    //    what any row already carrying either label becomes
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}

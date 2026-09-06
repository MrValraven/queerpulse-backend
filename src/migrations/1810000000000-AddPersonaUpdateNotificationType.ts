// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `persona_update`, the `notifications_type_enum` value behind "a persona you
 * follow published something new" (PRD-208).
 *
 * WHY IT EXISTS. Following a persona used to give the follower nothing. The
 * only consumer of `subprofile_followers` outside its own service was a single
 * `persona_followed` notification to the OWNER, so the follower got a jade
 * "Following" pill and never heard from that persona again. This is the value
 * that makes the button mean something: it reaches the FOLLOWER, and it is the
 * only type they ever receive because of a follow.
 *
 * WHAT IS WRITTEN UNDER IT. One row per follower when a live persona's content
 * section GREW: new items went up on a persona that is published, open, and
 * not owner-removed. An edit, a reorder, a retitle, a change to the persona's
 * own name or avatar, and anything in the `links` section all write nothing.
 * `SubprofileUpdatesService` owns that diff and spells out each exclusion.
 *
 * NO ACTOR IN THE PAYLOAD. The fan-out passes the persona owner's user id to
 * `NotificationsService.createForRecipients` so block and mute still filter
 * per recipient, but `persona_update` appears under no key in
 * `ACTOR_PAYLOAD_KEY` and its `PAYLOAD_ALLOWLIST` entry carries no user id, so
 * no follower's bell or lock screen ever names the human behind a pseudonymous
 * persona. The push handler skips the actor lookup for the same reason.
 *
 * BUNDLES, AND IS MUTABLE. It collapses on `subprofileId`
 * (`notification-bundling.ts`), so an owner filling in a whole section across
 * an afternoon is one unread row per follower rather than twenty. It also sits
 * behind its own member-facing switch, the new `persona_follows` preference
 * category, which governs both the bell and the push. A member who wants the
 * list of who they follow without the buzz turns that off and keeps every
 * persona they follow. The category itself needs NO migration: preference
 * categories are stored as a plain `varchar` on purpose (see
 * `notification-preferences.ts`), so adding one is a code-only change.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here:
 * the label must be COMMITTED before any statement may use it, so this opts
 * out of the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing in this
 * file uses the new label, and `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddPersonaUpdateNotificationType1810000000000 implements MigrationInterface {
  name = 'AddPersonaUpdateNotificationType1810000000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'persona_update'`,
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

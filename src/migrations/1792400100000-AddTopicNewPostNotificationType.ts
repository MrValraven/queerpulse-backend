import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `topic_new_post` `notifications_type_enum` value — DISC-3, sent to
 * a member who follows a topic (`topic_follows`) when a new post lands on it
 * (`TopicPostLinkService` linking a tagged forum thread, see
 * `AddTopicPostForumThreadLink1792400000000`). Emitted from
 * `TopicFollowNotificationsListener` (topics module).
 *
 * System-driven in one sense (the fan-out itself has no per-recipient human
 * actor deciding to notify them) but DOES carry the posting member as
 * `payload.actorId`, so block/mute still applies — see that listener's
 * docstring for why no `NotificationPreferenceCategory` gates it either (the
 * topic FOLLOW itself is the consent, mirroring `HousingListingMatch`'s
 * `alertsEnabled` precedent).
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddRecognitionNotificationTypes1789600000000`): `ALTER
 * TYPE ... ADD VALUE` must be COMMITTED before any statement may use the new
 * label, so this opts out of the wrapping transaction (`transaction = false`,
 * honoured because `data-source.ts` sets `migrationsTransactionMode: 'each'`).
 * `IF NOT EXISTS` keeps it re-run-safe. `down()` is a no-op: Postgres has no
 * `ALTER TYPE ... DROP VALUE`, and the added label is harmless if left.
 *
 * DO NOT RUN — authored for review only, per the task's instructions.
 */
export class AddTopicNewPostNotificationType1792400100000 implements MigrationInterface {
  name = 'AddTopicNewPostNotificationType1792400100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'topic_new_post'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added label is harmless.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}

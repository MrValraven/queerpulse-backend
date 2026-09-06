// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `community_post_removed`, the `notifications_type_enum` value behind
 * "a moderator took your post down" (PRD-147).
 *
 * Written by `CommunityPostsService.deletePost` and `deleteReply` to the
 * AUTHOR of the content, and only when the actor is somebody else: a member
 * tombstoning their own post writes no row, because nobody needs telling what
 * they just did. Before this, both cases looked identical from the outside.
 * Somebody whose post vanished found a tombstone and could not tell whether
 * they had broken a rule, which one, or who had decided it. Unexplained
 * removals drive members out and make a later bar feel arbitrary, and this is
 * the only channel that reaches them: QueerPulse sends no email and the
 * product offers no way to message a community's moderators.
 *
 * CARRIES THE MODERATOR'S OWN WORDS. The payload holds the member-facing
 * `reason` (the same class of value `community_banned`'s `reason` already
 * forwards, from a column with the same 500-character posture) plus the
 * snapshotted house rule that was cited, if any. It does NOT hold the removed
 * content's body, and it does not hold the moderators' internal note, which
 * stops at the community's own governance log.
 *
 * NO ACTOR, TWICE OVER. The payload never names the moderator who acted,
 * following `community_banned`: naming them puts them in front of whoever is
 * angriest about the takedown. The write site also declines to pass the actor
 * as `NotificationsService.create`'s block/mute argument, which is where this
 * departs from `community_banned`. A member who has blocked the moderator they
 * are in conflict with is the ordinary case here, and passing the actor would
 * silently drop precisely the takedowns most in need of explaining.
 *
 * ALWAYS DELIVERED AND IN-APP ONLY. It carries no
 * `NotificationPreferenceCategory` (it is listed under safety and moderation
 * in `ALWAYS_DELIVERED_NOTIFICATION_TYPES` instead), and it is deliberately
 * absent from `PushNotificationListener`'s push whitelist, matching
 * `community_banned`, which is the heavier act: "your post in <community> was
 * removed" on a lock screen outs a membership to whoever is stood nearby.
 *
 * ONE VALUE FOR POSTS AND REPLIES, the way `admin_queue_item` is one value for
 * twenty-six queues: the payload's `subject` field (`post` | `reply`) is what
 * the copy branches on, so a takedown of either is one type here and one
 * string on the client. The community's own governance log keeps them apart
 * with two actions, because that log is read to answer a different question.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here:
 * the label must be COMMITTED before any statement may use it, so this opts
 * out of the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing in this
 * file uses the new label, and `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddCommunityPostRemovedNotificationType1799010000000 implements MigrationInterface {
  name = 'AddCommunityPostRemovedNotificationType1799010000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_post_removed'`,
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

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `listing_public_question` and `listing_public_question_answered` to
 * `notifications_type_enum`.
 *
 * The first goes to a listing's OWNER when a member asks something on their
 * public page, carrying the asker as `actorId` so a blocked or muted asker is
 * filtered out by `NotificationsService.create` like any other member-driven
 * type. The second goes to the ASKER when their question is answered; it
 * carries an `actorId` only when the OWNER answered, and none when a moderator
 * did, because the asker is owed the answer rather than the name of the staff
 * member who wrote it.
 *
 * Neither gets a preference toggle (no entry in `NOTIFICATION_TYPE_CATEGORY`),
 * matching every other listing type: this is the platform telling you about
 * your own listing, or delivering the answer to a question you personally
 * asked. Both emit sites are best-effort and never throw, so a notification
 * failure can never roll back a question or an answer that has already
 * committed.
 *
 * ADD VALUE only, never used in the same transaction, so this is safe inside
 * the migration transaction on PostgreSQL 12+ — mirrors
 * `AddListingClaimNotificationTypes1790800200000` and
 * `AddListingEditSuggestionAcceptedNotificationType1791900000000`.
 */
export class AddListingPublicQuestionNotificationTypes1794300000000 implements MigrationInterface {
  name = 'AddListingPublicQuestionNotificationTypes1794300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_public_question'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_public_question_answered'`,
    );
  }

  public async down(): Promise<void> {
    // Fails loudly rather than reporting a successful revert that undid
    // nothing — see `AddListingPublicQuestionReportSubject1794290000000`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `digest_send_on_publish` + `digest_sent_at` to `magazine_issue`
 * (CNT-6 "Schedule with issue"). There is no scheduler/cron in the magazine
 * module — "schedule" means gating the digest send on the issue's real ship
 * action instead: `digest_send_on_publish` is toggled from the Digest &
 * Social tab (persisted through the existing `PATCH .../digest` endpoint),
 * and `MagazinePieceService.shipIssue` sends the digest to every confirmed
 * `newsletter_subscriptions` row the moment the issue actually ships, then
 * stamps `digest_sent_at` so a re-ship never re-sends it.
 *
 * Both columns are additive with safe defaults: `digest_send_on_publish`
 * defaults false (every existing issue keeps its current no-digest-on-ship
 * behavior), `digest_sent_at` is nullable with no default (null = not sent
 * yet, the idempotency guard `shipIssue` checks).
 */
export class AddMagazineIssueDigestSchedule1792900000000 implements MigrationInterface {
  name = 'AddMagazineIssueDigestSchedule1792900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" ADD "digest_send_on_publish" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" ADD "digest_sent_at" TIMESTAMP(3) WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" DROP COLUMN "digest_sent_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" DROP COLUMN "digest_send_on_publish"`,
    );
  }
}

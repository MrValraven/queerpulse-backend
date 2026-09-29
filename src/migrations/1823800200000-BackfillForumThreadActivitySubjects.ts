// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives every "started a thread" activity row written before
 * `1823800100000-AddForumThreadActivitySubjectKind` its thread as a subject.
 *
 * Those rows were written with a null subject, which `ActivityVisibilityService`
 * passes through unchecked, so a row for an anonymous thread, a withdrawn
 * thread or a thread in a private community kept naming it on the member's
 * profile. The thread slug is recovered from the stored link (`/thread/<slug>`,
 * `threadPath` in `profiles/activity-links.ts`). Once the rows carry a subject
 * the read gate re-checks them, and a row whose thread is no longer a public
 * fact is dropped and purged on the first profile read.
 *
 * `down()` returns every `forum_thread` row to a null subject. A row written by
 * the listener after this migration is indistinguishable from a backfilled one,
 * so it is reset too, which is the state the code before this change expects.
 */
export class BackfillForumThreadActivitySubjects1823800200000 implements MigrationInterface {
  name = 'BackfillForumThreadActivitySubjects1823800200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "activities"
          SET "subject_kind" = 'forum_thread',
              "subject_id" = substring("to_link" FROM 9)
        WHERE "subject_kind" IS NULL
          AND "to_link" LIKE '/thread/%'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "activities"
          SET "subject_kind" = NULL,
              "subject_id" = NULL
        WHERE "subject_kind" = 'forum_thread'`,
    );
  }
}

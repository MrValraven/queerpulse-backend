import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SUS-04: per-badge visibility.
 *
 * The badges page has always shown a "Visible on your profile" switch in the
 * badge drawer. It wrote to `localStorage`, and its own help text admitted as
 * much: "We're still building the part that hides it from how other people see
 * your profile." Meanwhile the ledger's trust bullets told members "Nothing
 * appears on your profile until you switch it on, badge by badge", which was
 * the opposite of what the code did in two ways at once.
 *
 * One boolean on `recognition_awards`, the row that already represents "this
 * member earned this badge". A separate visibility table would be 1:1 with it,
 * and every read of a member's badges already loads these rows, so the column
 * costs no join. NOT NULL DEFAULT false: a badge you earn is visible until you
 * say otherwise, which is what every existing row means today.
 *
 * No index. The only queries that touch this column already select by
 * `user_id` (`IDX_recognition_awards_user_id`) and then filter in memory over
 * a handful of rows.
 */
export class AddRecognitionBadgeVisibility1795401000000 implements MigrationInterface {
  name = 'AddRecognitionBadgeVisibility1795401000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recognition_awards"
         ADD COLUMN "hidden_from_profile" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recognition_awards" DROP COLUMN "hidden_from_profile"`,
    );
  }
}

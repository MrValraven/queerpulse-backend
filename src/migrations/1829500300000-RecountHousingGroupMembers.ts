// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recounts `housing_groups.member_count` as distinct approved members
 * (ENG-472).
 *
 * The figure used to count approved join-request ROWS, and nothing stopped a
 * member from asking twice, so a member approved on two requests counted as
 * two people and an anonymous by-name approval counted as a member with no
 * account behind it. `HousingGroupsService.refreshMemberCount` now counts
 * distinct approved `user_id`s; this brings every stored figure in line with
 * that rule once, so a group nobody triages again stops showing the old count.
 */
export class RecountHousingGroupMembers1829500300000 implements MigrationInterface {
  name = 'RecountHousingGroupMembers1829500300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "housing_groups" g SET "member_count" = (SELECT COUNT(DISTINCT r."user_id") FROM "group_join_requests" r WHERE r."group_id" = g."id" AND r."status" = 'approved' AND r."user_id" IS NOT NULL)`,
    );
  }

  public async down(): Promise<void> {
    // Intentionally empty. The previous figures were the drifted row counts
    // this migration corrects, and they are recomputed from the roster on the
    // next triage decision anyway, so there is nothing worth restoring.
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-HSG-28: makes `housing_groups.member_count` agree with the roster.
 *
 * The column was an admin-typed integer accepted straight off `CreateGroupDto`,
 * while `HousingGroupsService.computeMutualConnections` already treated the
 * approved `group_join_requests` rows as the actual membership. Two sources of
 * truth, and the public "N members" figure was whichever number a steward last
 * typed.
 *
 * `member_count` is now derived: the DTO no longer accepts it, and
 * `HousingGroupsService.refreshMemberCount` recounts it on every triage
 * decision. This aligns the rows written before that change.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class BackfillHousingGroupMemberCount1793630000000 implements MigrationInterface {
  name = 'BackfillHousingGroupMemberCount1793630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "housing_groups" SET "member_count" = (
         SELECT COUNT(*) FROM "group_join_requests" "request"
         WHERE "request"."group_id" = "housing_groups"."id"
           AND "request"."status" = 'approved'
       )`,
    );
  }

  public async down(): Promise<void> {
    // No-op: the previous values were hand-typed and are not recoverable, and
    // restoring them would reinstate the drift this fixes.
  }
}

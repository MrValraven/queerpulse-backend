import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInvitePersonal1782800810000 implements MigrationInterface {
  name = 'AddInvitePersonal1782800810000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Distinguishes an invite a member created themselves (POST /invites) from
    // one the system minted on their behalf — admin join-request approvals and
    // the genesis founder bootstrap. Only personal invites auto-vouch the
    // inviter for the member they bring in when the invite is redeemed at
    // signup; an admin approving a queued applicant is not a personal
    // endorsement. Defaults true so a member-created invite needs no extra flag.
    await queryRunner.query(
      `ALTER TABLE "invites" ADD "personal" boolean NOT NULL DEFAULT true`,
    );
    // Backfill: any already-existing invite minted by an approval is linked from
    // join_requests.invite_id, so mark those non-personal. Matters only for
    // still-pending approval invites (an already-accepted one is never redeemed
    // again); getting them right keeps a future redemption from mis-vouching the
    // approving admin.
    await queryRunner.query(
      `UPDATE "invites" SET "personal" = false WHERE "id" IN (` +
        `SELECT "invite_id" FROM "join_requests" WHERE "invite_id" IS NOT NULL)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "invites" DROP COLUMN "personal"`);
  }
}

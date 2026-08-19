import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `recognition_ledger_entries` — the append-only XP history ("receipts")
 * behind the frontend Badges page's `xpLedger`. Written from
 * `RecognitionAwardingService.recompute`; read (owner-only, newest-first,
 * capped) by `RecognitionService.getForUser`. Mirrors
 * `AddRecognition1782800130000`'s table/index/FK shape, and
 * `verification_events`' append-only-log precedent (`userId` + `createdAt`
 * composite index for the newest-first per-user query).
 */
export class AddRecognitionLedgerEntries1791600000000 implements MigrationInterface {
  name = 'AddRecognitionLedgerEntries1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "recognition_ledger_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "description" text NOT NULL,
        "xp" integer NOT NULL,
        "reason" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recognition_ledger_entries" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_recognition_ledger_entries_user_created" ON "recognition_ledger_entries" ("user_id", "created_at")`,
    );
    await queryRunner.query(`
      ALTER TABLE "recognition_ledger_entries" ADD CONSTRAINT "FK_recognition_ledger_entries_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recognition_ledger_entries" DROP CONSTRAINT "FK_recognition_ledger_entries_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "recognition_ledger_entries"`);
  }
}

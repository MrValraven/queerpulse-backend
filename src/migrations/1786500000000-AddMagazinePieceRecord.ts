// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the piece-record subsystem (spec §7.2, Magazine Desk redesign
 * Phase 2): `magazine_payment` (the 1:1 money side of a `MagazinePiece`,
 * enforced by a unique index on `piece_id`), `magazine_letter` (reader
 * letters, many per piece), and `magazine_correction` (published
 * corrections, many per piece).
 *
 * No `FOREIGN KEY` constraints are declared: mirrors `AddMagazinePieces` —
 * the entities (`magazine-payment.entity.ts` et al.) model `pieceId` as a
 * plain indexed `uuid` column, not a TypeORM relation.
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class AddMagazinePieceRecord1786500000000 implements MigrationInterface {
  name = 'AddMagazinePieceRecord1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "magazine_payment" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "piece_id" uuid NOT NULL,
        "fee" character varying NOT NULL,
        "expenses" character varying,
        "invoice" character varying,
        "filed_on" date,
        "terms" character varying NOT NULL DEFAULT '21 days',
        "due_on" date,
        "status" character varying NOT NULL DEFAULT 'agreed',
        "paid_on" date,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_payment" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_magazine_payment_piece" ON "magazine_payment" ("piece_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "magazine_letter" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "piece_id" uuid NOT NULL,
        "who" character varying NOT NULL,
        "body" text NOT NULL,
        "run_in_letters" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_letter" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_letter_piece" ON "magazine_letter" ("piece_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "magazine_correction" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "piece_id" uuid NOT NULL,
        "text" text NOT NULL,
        "published_on" date,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_correction" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_correction_piece" ON "magazine_correction" ("piece_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "magazine_correction"`);
    await queryRunner.query(`DROP TABLE "magazine_letter"`);
    await queryRunner.query(`DROP TABLE "magazine_payment"`);
  }
}

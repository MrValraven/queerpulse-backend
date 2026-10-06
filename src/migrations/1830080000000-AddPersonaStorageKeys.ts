// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T17: unlinked persona images move to keys that name nobody.
 *
 * Every storage key is `<prefix>/<userId>/<uuid><ext>`, and `toImageUrl`
 * publishes it as `/files/<key>`. On an unlinked (pseudonymous) persona that
 * middle segment tied the persona to its owner: the same id appears in the
 * owner's member avatar URL. Unlinked persona images now live under
 * `persona/<uuid>/<uuid><ext>`, with both segments random.
 *
 * Such a key has no owner segment for the storage layer to read, so this
 * table records, per persona-scoped key:
 * - `subprofile_id`: the persona it was minted for. `GET /files/*` serves the
 *   key only while a row names it, and `POST /uploads/crop` accepts it from
 *   that persona's members. The foreign key cascades on update, so the row
 *   follows the persona to the fresh id an unlink gives it
 *   (`issueFreshPersonaId`), and on delete, so a deleted persona's images
 *   stop serving at once.
 * - `uploaded_by_id`: whose upload the bytes came from, so a suspended
 *   member's persona images are withheld the way their other media is, and
 *   erasure, the Art. 20 export, My uploads and the admin media console find
 *   them. Set null when that account is erased.
 * - `upload_kind`: the kind the bytes were first stored as, for labels.
 *
 * Neither id reaches any response. The objects themselves are written by
 * the application (an unlink copies them, and every later image write to an
 * unlinked persona stores under the new scheme); this migration only adds
 * the table. Personas that were already unlinked are re-homed by the
 * one-off `src/storage/persona-image-backfill-cli.ts`.
 *
 * `down` drops the table. Persona-scoped keys still stored in persona
 * columns would then 404 until they are copied back.
 */
export class AddPersonaStorageKeys1830080000000 implements MigrationInterface {
  name = 'AddPersonaStorageKeys1830080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "persona_storage_keys" (
        "storage_key" character varying NOT NULL,
        "subprofile_id" uuid NOT NULL,
        "uploaded_by_id" uuid,
        "upload_kind" character varying(40),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_persona_storage_keys" PRIMARY KEY ("storage_key")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_persona_storage_keys_subprofile_id" ON "persona_storage_keys" ("subprofile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_persona_storage_keys_uploaded_by_id" ON "persona_storage_keys" ("uploaded_by_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "persona_storage_keys" ADD CONSTRAINT "FK_persona_storage_keys_subprofile"
        FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "persona_storage_keys" ADD CONSTRAINT "FK_persona_storage_keys_uploaded_by"
        FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id")
        ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "persona_storage_keys"`);
  }
}

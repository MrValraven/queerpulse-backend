import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `connection_notes`: an optional PRIVATE per-connection note, visible only to
 * the member who wrote it (SOC-14).
 *
 * `/account/connections` was an undifferentiated scroll past about fifty
 * people: five tabs, a Load more button, and nothing a member could add of
 * their own. This is the one piece of that item that needs schema. Search and
 * sort ride on the existing `connections` + `profiles` columns, and
 * `request_reason` was already captured at request time and simply never shown
 * back.
 *
 * UNIQUE `(connection_id, author_id)` rather than a bare surrogate key: a
 * member keeps at most one note per connection, so the pair IS the identity and
 * a re-save is an `ON CONFLICT DO UPDATE` upsert instead of a read-then-write
 * race. Both parties to a connection may keep their own note; neither is ever
 * loaded for the other, because the read is filtered on `author_id = <viewer>`.
 *
 * Both foreign keys CASCADE. A note about a relationship that no longer exists
 * has nothing to annotate, and an erased account must take its own private
 * notes with it: this is one member's private jotting, never content other
 * members depend on (contrast the `SET NULL` conversions in
 * `1794610000000-FixContentOwnerErasureCascades`, which protect content that
 * outlives its author).
 *
 * `IDX_connection_notes_author_id` backs the only read this table has: one
 * page of the connections list asks for `author_id = :viewer AND connection_id
 * IN (...)`, so the author is the selective leading column and the UNIQUE index
 * covers the `(connection_id, author_id)` upsert.
 *
 * No `CREATE INDEX CONCURRENTLY`: the table is created empty in this same
 * migration, so every index builds on nothing and the file stays transactional.
 */
export class CreateConnectionNote1794770000000 implements MigrationInterface {
  name = 'CreateConnectionNote1794770000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "connection_notes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "connection_id" uuid NOT NULL,
        "author_id" uuid NOT NULL,
        "body" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_connection_notes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_connection_notes_connection_author" UNIQUE ("connection_id", "author_id"),
        CONSTRAINT "FK_connection_notes_connection" FOREIGN KEY ("connection_id")
          REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_connection_notes_author" FOREIGN KEY ("author_id")
          REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_connection_notes_author_id"
        ON "connection_notes" ("author_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "connection_notes"`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the editor-desk workflow subsystem (spec §3.1–3.6, Magazine Desk
 * redesign Phase 1): `magazine_piece` (the commission/workflow spine,
 * `PieceStage`/`PieceFormat` as `varchar` "enums" — repo idiom, no Postgres
 * `CREATE TYPE`, see `MagazineDeck.publishedAt` precedent), `magazine_pitch`
 * (the editor inbox), `magazine_section` (seeded reference config powering
 * Issue-plan gap counts), and `magazine_piece_event` (the audit trail).
 *
 * `brief`/`care` on `magazine_piece` are opaque `jsonb`, validated at the
 * service boundary (`piece-jsonb.validation.ts`), never by TypeORM — mirrors
 * `magazine_deck.slides`. No `FOREIGN KEY` constraints are declared: the
 * entities (`magazine-piece.entity.ts` et al.) model `editorId`/`writerId`/
 * `issueId`/`articleId`/`deckId`/`pitchId` as plain indexed `uuid` columns,
 * not TypeORM relations, so none are added here either.
 *
 * Seeds `magazine_section` with the 10 sections from spec §3.5 (Cover,
 * Features, Reported, Interview, Essays, Service, Photo, Review, Column,
 * "Last word") with their target/note/orderIndex — static reference data,
 * not user-editable in Phase 1.
 */
export class AddMagazinePieces1786400000000 implements MigrationInterface {
  name = 'AddMagazinePieces1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "magazine_piece" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "format" character varying NOT NULL,
        "title" character varying NOT NULL,
        "section" character varying NOT NULL,
        "kind" character varying,
        "stage" character varying NOT NULL DEFAULT 'commissioned',
        "editor_id" uuid NOT NULL,
        "writer_id" uuid,
        "byline" character varying NOT NULL DEFAULT '',
        "due_on" date,
        "issue_id" uuid,
        "article_id" uuid,
        "deck_id" uuid,
        "word_target" integer,
        "slide_target" integer,
        "fresh" boolean NOT NULL DEFAULT false,
        "pitch_id" uuid,
        "order_index" integer,
        "pages" character varying,
        "laid_out" boolean NOT NULL DEFAULT false,
        "brief" jsonb,
        "care" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_piece" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_piece_editor" ON "magazine_piece" ("editor_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_piece_writer" ON "magazine_piece" ("writer_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_piece_issue" ON "magazine_piece" ("issue_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "magazine_pitch" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying NOT NULL,
        "from" character varying NOT NULL,
        "note" text NOT NULL,
        "tags" text[] NOT NULL DEFAULT '{}',
        "suggest_format" character varying,
        "status" character varying NOT NULL DEFAULT 'waiting',
        "fresh" boolean NOT NULL DEFAULT false,
        "issue_id" uuid,
        "pass_template" character varying,
        "pass_note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_pitch" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "magazine_section" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "target" integer NOT NULL,
        "note" character varying NOT NULL,
        "order_index" integer NOT NULL,
        CONSTRAINT "PK_magazine_section" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_magazine_section_name" ON "magazine_section" ("name")`,
    );

    await queryRunner.query(`
      CREATE TABLE "magazine_piece_event" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "piece_id" uuid NOT NULL,
        "actor_id" uuid,
        "action" character varying NOT NULL,
        "detail" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_piece_event" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_piece_event_piece" ON "magazine_piece_event" ("piece_id")`,
    );

    // --- seed: the 10 magazine sections (spec §3.5) -------------------------
    const sections: [string, number, string, number][] = [
      ['Cover', 1, 'One piece, always commissioned first', 0],
      ['Features', 2, 'Reported, 1200–3000 words', 1],
      ['Reported', 2, 'Data-led; deck or prose', 2],
      ['Interview', 1, 'Q&A format', 3],
      ['Essays', 3, 'At least one new voice', 4],
      ['Service', 2, 'Practical, checked twice', 5],
      ['Photo', 1, 'Deck only', 6],
      ['Review', 1, 'Books, film, nightlife', 7],
      ['Column', 1, 'Standing column', 8],
      ['Last word', 1, 'Written last, by an editor', 9],
    ];

    for (const [name, target, note, orderIndex] of sections) {
      await queryRunner.query(
        `INSERT INTO "magazine_section" ("name", "target", "note", "order_index")
         VALUES ($1, $2, $3, $4)`,
        [name, target, note, orderIndex],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "magazine_piece_event"`);
    await queryRunner.query(`DROP TABLE "magazine_pitch"`);
    await queryRunner.query(`DROP TABLE "magazine_piece"`);
    await queryRunner.query(`DROP TABLE "magazine_section"`);
  }
}

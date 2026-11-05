// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Leads: the staff directory of acts, venues and businesses to bring onto the
 * platform (`leads`), and each lead's dated entry log (`lead_entries`).
 *
 * Every CHECK mirrors a service check that runs first, so a violation never
 * reaches the driver with a lead's name or email in its error text. The keys
 * to `subprofiles` cascade on update, because a pseudonym unlink rekeys the
 * persona; `UQ_leads_linked_subprofile` and `IDX_lead_entries_subprofile_id`
 * back them, so a rekey or delete scans neither table.
 * `lead_entries.created_at` defaults to `clock_timestamp()`, so the entries
 * one transaction writes keep their insert order.
 *
 * Both tables are new and empty, so every index builds inside the migration
 * transaction. No trigram index: leads is a few hundred staff rows, and the
 * list search is a folded `LIKE` a sequential scan serves. The statements
 * carry no `IF NOT EXISTS` guards and no row is inserted.
 */
export class AddLeads1839300000000 implements MigrationInterface {
  name = 'AddLeads1839300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "leads" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(120) NOT NULL,
        "type" character varying(20) NOT NULL,
        "stage" character varying(20) NOT NULL DEFAULT 'to_contact',
        "location" character varying(120),
        "email" character varying(254),
        "phone" character varying(40),
        "links" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "follow_up_on" date,
        "linked_subprofile_id" uuid,
        "created_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_leads" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_leads_linked_subprofile" UNIQUE ("linked_subprofile_id"),
        CONSTRAINT "CHK_leads_name" CHECK (char_length(btrim("name")) >= 1),
        CONSTRAINT "CHK_leads_type" CHECK ("type" IN ('artist', 'dj', 'band', 'venue', 'promoter', 'collective', 'business', 'other')),
        CONSTRAINT "CHK_leads_stage" CHECK ("stage" IN ('to_contact', 'contacted', 'in_talks', 'on_board', 'not_now')),
        CONSTRAINT "CHK_leads_email" CHECK ("email" IS NULL OR "email" = lower(btrim("email"))),
        CONSTRAINT "CHK_leads_links" CHECK (CASE WHEN jsonb_typeof("links") = 'array' THEN jsonb_array_length("links") <= 12 ELSE false END),
        CONSTRAINT "FK_leads_linked_subprofile" FOREIGN KEY ("linked_subprofile_id") REFERENCES "subprofiles"("id") ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "FK_leads_created_by" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_leads_email" ON "leads" ("email") WHERE "email" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_leads_stage" ON "leads" ("stage")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_leads_follow_up_on" ON "leads" ("follow_up_on") WHERE "follow_up_on" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_leads_created_by_id" ON "leads" ("created_by_id") WHERE "created_by_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "lead_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "lead_id" uuid NOT NULL,
        "kind" character varying(20) NOT NULL,
        "body" text,
        "from_stage" character varying(20),
        "to_stage" character varying(20),
        "subprofile_id" uuid,
        "author_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
        "edited_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_lead_entries" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_lead_entries_kind" CHECK ("kind" IN ('note', 'stage_changed', 'persona_linked', 'persona_unlinked', 'created')),
        CONSTRAINT "CHK_lead_entries_note_body" CHECK (("kind" = 'note') = ("body" IS NOT NULL)),
        CONSTRAINT "CHK_lead_entries_body_length" CHECK ("body" IS NULL OR char_length("body") <= 4000),
        CONSTRAINT "CHK_lead_entries_from_stage" CHECK ("from_stage" IS NULL OR "from_stage" IN ('to_contact', 'contacted', 'in_talks', 'on_board', 'not_now')),
        CONSTRAINT "CHK_lead_entries_to_stage" CHECK ("to_stage" IS NULL OR "to_stage" IN ('to_contact', 'contacted', 'in_talks', 'on_board', 'not_now')),
        CONSTRAINT "CHK_lead_entries_edited_note" CHECK ("edited_at" IS NULL OR "kind" = 'note'),
        CONSTRAINT "FK_lead_entries_lead" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_lead_entries_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "FK_lead_entries_author" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lead_entries_lead_created_at" ON "lead_entries" ("lead_id", "created_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lead_entries_subprofile_id" ON "lead_entries" ("subprofile_id") WHERE "subprofile_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lead_entries_author_id" ON "lead_entries" ("author_id") WHERE "author_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "lead_entries"`);
    await queryRunner.query(`DROP TABLE "leads"`);
  }
}

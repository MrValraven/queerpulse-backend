// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `legal_requests` — the register of legal, government and law-enforcement
 * demands for member data (PRD-32).
 *
 * The public Transparency Report counted reports, moderator actions, appeals
 * and frozen communities, and published nothing at all about third-party legal
 * demands: no register modelled one anywhere in either repo, and the report did
 * not disclose the omission. For a platform whose product is queer safety,
 * "how often were we asked to hand over member data" is the line members read
 * first, and an absent section reads as an answer. This table is the thing
 * being counted; `TransparencyService` publishes the aggregate over it.
 *
 * ## Shape notes
 *
 *  - `received_on` is a `date`, not a timestamp. The hour a subpoena landed is
 *    nobody's business, and a per-request instant has no place in a table whose
 *    aggregate is published. It is also the axis the reporting quarter slices
 *    on.
 *  - `data_disclosed` is `text[]` of stable keys from
 *    `LEGAL_REQUEST_DATA_CATEGORIES`, validated at the DTO boundary, following
 *    the `community_support_offers.options` precedent. Empty means nothing was
 *    handed over.
 *  - `accounts_notified` is its own integer beside `member_notified_on`: a
 *    notice that reached three of eleven named accounts is three, and inferring
 *    the figure from a date alone would publish eleven.
 *  - There is NO delete path. A row entered in error is voided
 *    (`voided_at` / `voided_by_user_id` / `void_reason`) and stays. A register
 *    of state demands that can be quietly emptied is worth less than no
 *    register, because its silence still gets published as a zero.
 *
 * FK behaviour. Both actor columns are nullable and `ON DELETE SET NULL`, the
 * actor-FK convention this repo follows (`reports.assigned_moderator_id`,
 * `community_support_offers.offered_by_user_id`): the account-erasure sweep
 * must never be blocked by, or able to erase, the record of a state demand.
 * `recorded_by_name` is the write-time snapshot that keeps the row readable in
 * exactly that case.
 *
 * TRANSACTIONAL, and safely so. Both `CREATE TYPE`s are new types rather than
 * an `ALTER TYPE ... ADD VALUE` on an existing one, so the non-transactional
 * rule those files opt out for does not apply. The index builds on a table
 * created empty in the same transaction, so no `CONCURRENTLY` is needed.
 */
export class CreateLegalRequests1795820000000 implements MigrationInterface {
  name = 'CreateLegalRequests1795820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "legal_requests_type_enum" AS ENUM
        ('subpoena', 'court_order', 'police_request',
         'emergency_disclosure_request', 'preservation_request',
         'takedown_demand', 'other')
    `);
    await queryRunner.query(`
      CREATE TYPE "legal_requests_outcome_enum" AS ENUM
        ('complied_in_full', 'complied_in_part', 'narrowed', 'refused',
         'withdrawn', 'pending')
    `);
    await queryRunner.query(`
      CREATE TABLE "legal_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "requesting_body" character varying(200) NOT NULL,
        "jurisdiction" character varying(120) NOT NULL,
        "request_type" "legal_requests_type_enum" NOT NULL,
        "received_on" date NOT NULL,
        "accounts_affected" integer NOT NULL DEFAULT 0,
        "outcome" "legal_requests_outcome_enum" NOT NULL DEFAULT 'pending',
        "data_disclosed" text array NOT NULL DEFAULT '{}',
        "member_notified_on" date,
        "accounts_notified" integer NOT NULL DEFAULT 0,
        "notification_withheld_reason" text,
        "is_under_gag_order" boolean NOT NULL DEFAULT false,
        "internal_note" text,
        "recorded_by_user_id" uuid,
        "recorded_by_name" character varying(200),
        "voided_at" TIMESTAMP WITH TIME ZONE,
        "voided_by_user_id" uuid,
        "void_reason" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_legal_requests" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_legal_requests_accounts_affected_non_negative"
          CHECK ("accounts_affected" >= 0),
        CONSTRAINT "CHK_legal_requests_accounts_notified_within_affected"
          CHECK ("accounts_notified" >= 0
                 AND "accounts_notified" <= "accounts_affected"),
        CONSTRAINT "FK_legal_requests_recorded_by" FOREIGN KEY ("recorded_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_legal_requests_voided_by" FOREIGN KEY ("voided_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    // Both readers walk this table by receipt date: the Transparency Report
    // takes one quarter as a half-open range, and the admin register lists
    // newest first. `id DESC` breaks the tie so a page under offset pagination
    // is stable when several demands arrived the same day.
    await queryRunner.query(`
      CREATE INDEX "IDX_legal_requests_received_on"
        ON "legal_requests" ("received_on" DESC, "id" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "legal_requests"`);
    await queryRunner.query(`DROP TYPE "legal_requests_outcome_enum"`);
    await queryRunner.query(`DROP TYPE "legal_requests_type_enum"`);
  }
}

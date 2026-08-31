import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `status_incidents` — the operator-authored half of the public status page
 * (`GET /status`, ID-16).
 *
 * WHY. QueerPulse delivers no email, so a member who cannot sign in has no
 * channel that can reach them: "the platform is down", "I have been suspended"
 * and "my account is broken" are one indistinguishable silence. The status page
 * is the only surface that can answer without a session, and the probes in
 * `src/health/` can only tell it whether Postgres answers a ping. Everything
 * else worth saying — a degraded upload path, a sign-in provider misbehaving, a
 * planned maintenance window, and above all "yes, this is us, not you" — has to
 * be written by a person. This table is where they write it.
 *
 * NOT USER CONTENT, AND STILL SANITIZED. Only
 * `AdminStatusIncidentsService` writes here, behind `@Roles(Moderator, Admin)`.
 * `title` and `body` are nonetheless stripped to plain text at the write
 * boundary (`toStoredPlainText`), because they are rendered verbatim to
 * UNAUTHENTICATED visitors and a crafted API call bypasses whatever the admin
 * pane does on the way in.
 *
 * COLUMNS AND THEIR SHAPES.
 *  - `affected_components` is `text[]`, holding `StatusComponentId` values from
 *    the registry in `src/status/status-components.ts`. No FK and no enum type:
 *    the component list is application-level (it is a member-facing grouping,
 *    not a stored entity), and the public read drops any id the registry no
 *    longer recognises, so retiring a component cannot break an old incident.
 *    Empty is legitimate and means "worth announcing, degrades nothing".
 *  - `severity` and `status` are Postgres enums rather than varchar, because
 *    both are genuinely closed sets that the public page's state derivation
 *    depends on (`SEVERITY_IMPACT` in `StatusService`) — an unexpected value
 *    would silently mis-colour a component.
 *  - `started_at` is separate from `created_at` on purpose: trouble is almost
 *    always noticed after it starts, and a status page that dates an incident
 *    from when someone got round to writing it up is lying about the window.
 *  - `resolved_at` is derived from `status` in one place in the service, so the
 *    two can never disagree.
 *  - `authored_by_user_id` is `ON DELETE SET NULL`, mirroring
 *    `mod_audit_logs.actor_id` / `roadmap_audit_log.actor_id`: the record of
 *    what was announced must survive its author erasing their account.
 *    `authored_by_label` is the display-name SNAPSHOT that keeps that record
 *    readable afterwards, exactly as `RoadmapAuditLog.actorLabel` does. Neither
 *    column is ever exposed publicly — an anonymous visitor is not told who
 *    operates the platform.
 *
 * INDEX. One composite `(status, started_at DESC)`. Both reads are "filter by
 * status, newest first": the public one takes everything unresolved plus
 * resolved-within-30-days, the admin one takes the same without the recency
 * bound. `DESC` is spelled out here because the TypeORM decorator API cannot
 * express column sort order (same caveat as `RoadmapAuditLog`'s `created_at`
 * index).
 *
 * TRANSACTIONAL. Two CREATE TYPEs, one CREATE TABLE, one CREATE INDEX and one
 * ADD CONSTRAINT, every object but `users` created inside this same
 * transaction, so nothing waits on a lock another session holds and no
 * `CONCURRENTLY` two-phase split is needed.
 */
export class CreateStatusIncidents1794630000000 implements MigrationInterface {
  name = 'CreateStatusIncidents1794630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "status_incidents_severity_enum" AS ENUM (
        'minor', 'major', 'critical'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "status_incidents_status_enum" AS ENUM (
        'open', 'monitoring', 'resolved'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "status_incidents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying(160) NOT NULL,
        "body" text NOT NULL,
        "affected_components" text array NOT NULL DEFAULT '{}',
        "severity" "status_incidents_severity_enum" NOT NULL DEFAULT 'minor',
        "status" "status_incidents_status_enum" NOT NULL DEFAULT 'open',
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "authored_by_user_id" uuid,
        "authored_by_label" character varying(120) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_status_incidents" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_status_incidents_status_started_at"
         ON "status_incidents" ("status", "started_at" DESC)`,
    );
    await queryRunner.query(`
      ALTER TABLE "status_incidents"
        ADD CONSTRAINT "FK_status_incidents_authored_by_user_id"
        FOREIGN KEY ("authored_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "status_incidents" DROP CONSTRAINT "FK_status_incidents_authored_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_status_incidents_status_started_at"`,
    );
    await queryRunner.query(`DROP TABLE "status_incidents"`);
    await queryRunner.query(`DROP TYPE "status_incidents_status_enum"`);
    await queryRunner.query(`DROP TYPE "status_incidents_severity_enum"`);
  }
}

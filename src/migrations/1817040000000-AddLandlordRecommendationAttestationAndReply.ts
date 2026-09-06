// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-249. Gives a landlord recommendation the two things it has always
 * lacked: a claim by its author that they actually rented from this person,
 * and a way for the person being rated to answer back.
 *
 * THE PROBLEM, in the service's own words before this change
 * (`landlords.service.ts`, the "still open" follow-up): "there is no proof the
 * recommender ever rented from this landlord", beside a harm statement saying a
 * recommendation is "a public, named rating of a real third party who is not a
 * member here and has no right of reply on this surface, and it feeds
 * `ratingFromRecommendations` on every landlord card". Housing reviews of
 * listers, by contrast, are gated on a completed viewing and carry a
 * `listerReplyText`. This surface had neither.
 *
 * WHY NOT THE VIEWING-STYLE GATE. A completed-viewing gate is the in-repo
 * precedent and it was deliberately NOT chosen: most people found their home
 * through a landlord they met off-platform, so an interaction gate would
 * silence exactly the tenants with the most to say. The maintainer chose
 * attestation plus labelling plus a right of reply instead.
 *
 * ATTESTATION (`attested_at`, `tenancy_started_on`, `tenancy_ended_on`).
 * Required for every NEW recommendation, nullable in the column because every
 * existing row predates the question. `attested_at` is the discriminator that
 * separates the two meanings of a null `tenancy_ended_on`: "still renting
 * there" on an attested row, "this row never answered" on an old one.
 *
 * MONTH PRECISION, `varchar(7)` holding `YYYY-MM`, never a `date`. A date
 * column would demand a day nobody remembers and then print it back as if it
 * were known.
 *
 * RIGHT OF REPLY (`landlord_reply_text`, `..._published_at`, `..._published_by`).
 * A landlord has no account and is never given one: a claimed entry is an entry
 * its subject can shape, which inverts the directory's purpose. Instead the
 * landlord fills a public form that lands in the existing admin intake queue
 * under a new `landlord_reply_request` kind (no DDL: `intake_submissions.kind`
 * is a varchar with a code-side allowlist), a human establishes they are the
 * person named, and staff publish the reply under the words it answers.
 *
 * NO FK ON `landlord_reply_published_by`, deliberately, matching
 * `landlords.decided_by`: a published decision must outlive the staff account
 * that made it.
 *
 * ONE SAFETY CONSEQUENCE WORTH RECORDING, because it is not obvious from the
 * DDL. `report-subject-resolver.service.ts` documented this subject type as
 * "NOT AUTHOR-AMBIGUOUS ... there is no reply field and no second contributor,
 * so unlike a review the reported words can only be the one author's". Adding a
 * reply falsifies that: a report about an abusive landlord REPLY would have
 * resolved to the TENANT, and a `restrict`, `suspend` or `ban` would have
 * landed on the person warning others about their landlord. The resolver now
 * reports `is_author_ambiguous` as true whenever a reply stands.
 *
 * NO INDEX: `attested_at` is only ever read inside a `COUNT(*) FILTER` over a
 * set already narrowed by `landlord_id`, which
 * `IDX_landlord_recommendations_landlord_id` covers.
 */
export class AddLandlordRecommendationAttestationAndReply1817040000000
  implements MigrationInterface
{
  name = 'AddLandlordRecommendationAttestationAndReply1817040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "landlord_recommendations"
        ADD COLUMN IF NOT EXISTS "attested_at"                 TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "tenancy_started_on"          CHARACTER VARYING(7),
        ADD COLUMN IF NOT EXISTS "tenancy_ended_on"            CHARACTER VARYING(7),
        ADD COLUMN IF NOT EXISTS "landlord_reply_text"         CHARACTER VARYING(2000),
        ADD COLUMN IF NOT EXISTS "landlord_reply_published_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "landlord_reply_published_by" UUID
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "landlord_recommendations"
        DROP COLUMN IF EXISTS "attested_at",
        DROP COLUMN IF EXISTS "tenancy_started_on",
        DROP COLUMN IF EXISTS "tenancy_ended_on",
        DROP COLUMN IF EXISTS "landlord_reply_text",
        DROP COLUMN IF EXISTS "landlord_reply_published_at",
        DROP COLUMN IF EXISTS "landlord_reply_published_by"
    `);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integrity fix (audit P1-6 / section B): five user-reference columns were
 * created as plain uuids with NO foreign key, so an account-erasure hard-delete
 * of a `users` row left dangling UUIDs behind — and made the account-deletion
 * processor's "70+ FKs verified" invariant
 * (`account-deletion-processor.service.ts:158`) false.
 *
 * All five columns are already nullable, so each gets an `ON DELETE SET NULL`
 * foreign key to `users(id)` — an erasure nulls the identity out while the row
 * (a co-op join request, a landlord intro request, a review, a moderation
 * suggestion) survives with its content intact, exactly as the columns'
 * nullability was always designed for.
 *
 *   - coop_join_requests.user_id                    -> users(id) ON DELETE SET NULL
 *   - landlord_intro_requests.user_id               -> users(id) ON DELETE SET NULL
 *   - listing_reviews.reviewer_id                   -> users(id) ON DELETE SET NULL
 *   - listing_edit_suggestions.suggested_by_user_id -> users(id) ON DELETE SET NULL
 *   - listing_edit_suggestions.resolved_by_user_id  -> users(id) ON DELETE SET NULL
 *
 * Each SET NULL column also gets its backing index (none were indexed before) so
 * the delete-time null-out doesn't sequential-scan the child table. Mirrors
 * `1785001300000-AddEventPhotoAndFeaturedCommunityForeignKeys.ts`, the repo's
 * convention for retrofitting missing FKs. The matching `@ManyToOne` +
 * `@JoinColumn` (with `onDelete: 'SET NULL'`) relations are on the entities so
 * schema and metadata stay in sync and a future `migration:generate` won't emit
 * a DROP.
 *
 * NOTE: FK creation is validated against existing data, so it fails loudly if a
 * `*_id` column already points at a since-deleted `users` row (an orphan).
 * These tables have had FK integrity in application code since day one, so no
 * orphan is expected; clean any up first if one is present.
 */
export class AddUserRefForeignKeys1785600300000 implements MigrationInterface {
  name = 'AddUserRefForeignKeys1785600300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- coop_join_requests -------------------------------------------------
    await queryRunner.query(
      `CREATE INDEX "IDX_coop_join_requests_user_id" ON "coop_join_requests" ("user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "coop_join_requests" ADD CONSTRAINT "FK_coop_join_requests_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- landlord_intro_requests --------------------------------------------
    await queryRunner.query(
      `CREATE INDEX "IDX_landlord_intro_requests_user_id" ON "landlord_intro_requests" ("user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "landlord_intro_requests" ADD CONSTRAINT "FK_landlord_intro_requests_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- listing_reviews ----------------------------------------------------
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_reviews_reviewer_id" ON "listing_reviews" ("reviewer_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "listing_reviews" ADD CONSTRAINT "FK_listing_reviews_reviewer_id"
        FOREIGN KEY ("reviewer_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- listing_edit_suggestions (two user refs) ---------------------------
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_edit_suggestions_suggested_by_user_id" ON "listing_edit_suggestions" ("suggested_by_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_edit_suggestions_resolved_by_user_id" ON "listing_edit_suggestions" ("resolved_by_user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "listing_edit_suggestions" ADD CONSTRAINT "FK_listing_edit_suggestions_suggested_by_user_id"
        FOREIGN KEY ("suggested_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "listing_edit_suggestions" ADD CONSTRAINT "FK_listing_edit_suggestions_resolved_by_user_id"
        FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // --- listing_edit_suggestions -------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "listing_edit_suggestions" DROP CONSTRAINT "FK_listing_edit_suggestions_resolved_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_edit_suggestions" DROP CONSTRAINT "FK_listing_edit_suggestions_suggested_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_listing_edit_suggestions_resolved_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_listing_edit_suggestions_suggested_by_user_id"`,
    );

    // --- listing_reviews ----------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "listing_reviews" DROP CONSTRAINT "FK_listing_reviews_reviewer_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_listing_reviews_reviewer_id"`);

    // --- landlord_intro_requests --------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "landlord_intro_requests" DROP CONSTRAINT "FK_landlord_intro_requests_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_landlord_intro_requests_user_id"`);

    // --- coop_join_requests -------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "coop_join_requests" DROP CONSTRAINT "FK_coop_join_requests_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_coop_join_requests_user_id"`);
  }
}

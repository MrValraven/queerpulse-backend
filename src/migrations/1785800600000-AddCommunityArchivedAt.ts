import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `communities.archived_at` — the timestamp an owner archived the
 * community from the mod panel's danger zone. NULL for every existing row
 * (nothing is archived by default), so this is a metadata-only `ADD COLUMN`
 * with a NULL default: fast, non-rewriting, and safe to run online without
 * `CONCURRENTLY` (that clause is only for index builds). Kept inside the
 * default batch transaction — no `transaction = false` opt-out needed here.
 *
 * The matching `@Column({ nullable: true }) archivedAt` decorator is on
 * `Community` (`communities/entities/community.entity.ts`) so entity metadata
 * and schema stay in sync for any future `migration:generate` diff.
 *
 * Read paths gate on it (`CommunitiesService`): archived communities drop out
 * of `list`/`searchByText`/`myCommunities`, and `getBySlug` 404s them for
 * everyone but the community's own owner/mods (same leak-safe posture as a
 * moderator takedown).
 */
export class AddCommunityArchivedAt1785800600000 implements MigrationInterface {
  name = 'AddCommunityArchivedAt1785800600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "archived_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "archived_at"`,
    );
  }
}

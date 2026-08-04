import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Performance-track fix (unpaginated roster): `CommunitiesService.roster`
 * (`communities.service.ts`) used to run `this.members.find({ where: {
 * communityId }, order: { joinedAt: 'ASC' } })` with no `LIMIT` at all —
 * every member row for the whole community, on every roster read. It now
 * pages through `common/pagination.ts`'s `paginate()`, filtering
 * `community_id` and ordering by `joined_at`. Today `community_members` only
 * carries `IDX_community_members_community_id` (a single column on
 * `community_id`) — the filter is served but the sort still needs a separate
 * in-memory step per page. A composite `(community_id, joined_at)` index lets
 * Postgres serve the filter AND the sort from one index walk, the same
 * "filter indexed, sort not" fix already applied to `community_posts` in
 * `1785001600000-AddCommunityPostsFeedOrderIndex.ts`.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
 * ("`CREATE INDEX`", PostgreSQL manual); this project's migration runner uses
 * `migrationsTransactionMode: 'each'` (`src/data-source.ts`), so a migration
 * opting out via `transaction = false` runs standalone without needing a
 * separate `--transaction none` invocation.
 */
export class AddCommunityMembersRosterOrderIndex1785700400000 implements MigrationInterface {
  name = 'AddCommunityMembersRosterOrderIndex1785700400000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). Re-runnability comes
  // from the deploy preflight dropping invalid indexes, not `IF NOT EXISTS`
  // (forbidden here — hides drift). See 1785001500000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_members_roster_order" ` +
        `ON "community_members" ("community_id", "joined_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_community_members_roster_order"`,
    );
  }
}

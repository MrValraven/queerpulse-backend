import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforces at most one `owner` roster row per community at the database
 * level: `CREATE UNIQUE INDEX ... ON community_members (community_id) WHERE
 * role = 'owner'`. Closes the gap the owner-erasure fix opened up —
 * `CommunityOwnerOrphanService.handleOwnerErasure` promotes a `mod` to
 * `owner` on the roster AND updates `communities.owner_id`, and this index is
 * the belt-and-braces guarantee that a race (two ticks of an erasure sweep,
 * or a concurrent manual ownership transfer) can never leave two `owner` rows
 * on the same roster — the second INSERT/UPDATE gets a 23505 instead.
 * Doesn't touch `communities.owner_id` itself (already `UQ`-free by design:
 * it's a single scalar, not a set of rows).
 *
 * `community_members` already carries production traffic (see the prior
 * `CONCURRENTLY` migrations against sibling tables in this feature, e.g.
 * `AddCommunitiesCreatedAtIndex1785700200000`), so this is built `CREATE
 * UNIQUE INDEX CONCURRENTLY`, never a blocking plain `CREATE INDEX`.
 * `CONCURRENTLY` cannot run inside a transaction block, so this migration
 * opts out via `transaction = false` (honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`) and is kept as its own migration file,
 * separate from the FK-cascade fix, exactly because of that transaction-mode
 * constraint.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddCommunityMembersOwnerUniqueIndex1790100000000 implements MigrationInterface {
  name = 'AddCommunityMembersOwnerUniqueIndex1790100000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "UQ_community_members_one_owner" ` +
        `ON "community_members" ("community_id") WHERE "role" = 'owner'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "UQ_community_members_one_owner"`,
    );
  }
}

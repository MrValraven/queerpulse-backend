// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `co_owner` to `community_members_role_enum`.
 *
 * A community run by more than one person had no way to say so: the roster
 * offered `mod` (moderation powers only) or nothing, so co-founders ended up
 * sharing one login or naming one person owner and hoping. `co_owner` is a
 * roster role carrying OWNER-LEVEL powers inside the community (settings,
 * roster, moderation, resources).
 *
 * WHAT THIS DOES NOT CHANGE, stated plainly because it is the whole design:
 * the single-owner constraint on `communities.owner_id` is UNCHANGED. That
 * column still holds exactly ONE accountable owner of record, it is still what
 * every ownership transfer, orphan-handling path
 * (`CommunityOwnerOrphanService`) and admin surface reads, and a co-owner is
 * never written into it. There is still exactly one person answerable for a
 * community. Promoting a co-owner to actual owner remains an explicit
 * ownership transfer, and nothing here makes it implicit.
 *
 * Inserted `BEFORE 'mod'` so the enum's own sort order matches the authority
 * hierarchy (`owner` > `co_owner` > `mod` > `member`), which keeps any
 * `ORDER BY role` on the roster reading correctly.
 *
 * NON-TRANSACTIONAL, like every other `ADD VALUE` migration here (see
 * `AddBarterProposalReceivedNotificationType1793720000000`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddCommunityCoOwnerRole1793920000000 implements MigrationInterface {
  name = 'AddCommunityCoOwnerRole1793920000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "community_members_role_enum" ADD VALUE IF NOT EXISTS 'co_owner' BEFORE 'mod'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no `ALTER TYPE ... DROP VALUE`. Reverting needs the
    // rename-and-recreate dance (see `RemovePendingStatus1782800740000`) AND a
    // decision about what any existing `co_owner` roster rows become, which is
    // a real data decision this migration must not silently guess at.
    // Failing loudly beats reporting a successful revert that undid nothing: a
    // silent no-op removes the ledger row, so the next `migration:run` retries
    // `ADD VALUE` against a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value, and down() would ' +
        'have to decide what existing co_owner roster rows become. Write a ' +
        'follow-up migration by hand if this needs reverting.',
    );
  }
}

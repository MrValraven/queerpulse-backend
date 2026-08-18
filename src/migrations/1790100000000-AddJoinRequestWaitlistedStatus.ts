import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a `waitlisted` disposition to join-request review, sitting between
 * `pending` and a final `approved`/`declined`: some requests need a follow-up
 * question or a second opinion rather than a clean yes/no on first read. See
 * the invite-review admin guidelines audit (2026-08-18), Engineering item E7.
 *
 * ALTER TYPE ... ADD VALUE, following the precedent in
 * AddDeactivatedStatus1782800710000 and AddNotificationTypes1782693000000.
 * Safe here for the same reason those are safe: `src/data-source.ts` sets
 * `migrationsTransactionMode: 'each'`, so this migration runs in its own
 * transaction, and nothing in `up()` writes or compares the new label —
 * it is first used at runtime, in a separate transaction, by
 * `JoinRequestsService.review()`.
 */
export class AddJoinRequestWaitlistedStatus1790100000000
  implements MigrationInterface
{
  name = 'AddJoinRequestWaitlistedStatus1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "join_requests_status_enum" ADD VALUE IF NOT EXISTS 'waitlisted'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no DROP VALUE. Reverting would require the
    // rename-and-recreate dance (see RemovePendingStatus1782800740000) AND a
    // decision about what any 'waitlisted' rows become — that's a real data
    // decision, not something this migration should silently guess at. Leave
    // `down()` as a documented no-op; a revert of this feature needs its own
    // hand-authored migration once it's known whether any row is waitlisted.
    throw new Error(
      'Irreversible: down() would need to decide what to do with existing ' +
        "'waitlisted' rows. Write a follow-up migration by hand if this " +
        'needs reverting.',
    );
  }
}

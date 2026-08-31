import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The enum labels the co-manager feature adds to two EXISTING types.
 *
 * `listing_moderation_events_action_enum` gains:
 *  - `co_manager_added` — a member accepted an invitation and now has access.
 *    Written on the accept, not on the invite: that is when access begins.
 *  - `co_manager_removed` — an ACTIVE seat ended, either because the owner took
 *    it back or because the co-manager stepped down. The mass revocation an
 *    approved ownership claim performs is not logged per seat; its count rides
 *    in the existing `ownership_transferred` row's own reason.
 *
 * `notifications_type_enum` gains:
 *  - `listing_co_manager_invite` — to the invited member.
 *  - `listing_co_manager_invite_accepted` / `..._declined` — back to the owner.
 *
 * NON-TRANSACTIONAL, LOUDLY. This is the whole reason this migration is split
 * out of `CreateListingCoManagers1794520000000` instead of being one file.
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use the
 * new label, so it opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). This follows
 * `AddCommunityCoOwnerRole1793920000000`, the closest sibling this feature has,
 * rather than the in-transaction `ADD VALUE` some earlier listing migrations
 * used. Nothing here uses any of the five new labels, so there is no
 * same-transaction hazard either way, and the safer of the two precedents is
 * the one worth copying. `IF NOT EXISTS` keeps every statement re-run-safe.
 *
 * `up()` is therefore NOT atomic: a failure partway leaves the labels added so
 * far in place. That is harmless and re-running is safe, but it is stated here
 * rather than discovered.
 */
export class AddListingCoManagerEnumValues1794530000000 implements MigrationInterface {
  name = 'AddListingCoManagerEnumValues1794530000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "listing_moderation_events_action_enum" ADD VALUE IF NOT EXISTS 'co_manager_added'`,
    );
    await queryRunner.query(
      `ALTER TYPE "listing_moderation_events_action_enum" ADD VALUE IF NOT EXISTS 'co_manager_removed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_co_manager_invite'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_co_manager_invite_accepted'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_co_manager_invite_declined'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no `ALTER TYPE ... DROP VALUE`. Reverting needs the
    // rename-and-recreate dance (see `RemovePendingStatus1782800740000`) AND a
    // decision about what any existing rows carrying these labels become, which
    // is a real data decision this migration must not silently guess at.
    // Failing loudly beats reporting a successful revert that undid nothing: a
    // silent no-op removes the ledger row, so the next `migration:run` retries
    // `ADD VALUE` against labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value, and down() would ' +
        'have to decide what existing co_manager_added / co_manager_removed ' +
        'events and listing_co_manager_* notifications become. Write a ' +
        'follow-up migration by hand if this needs reverting.',
    );
  }
}

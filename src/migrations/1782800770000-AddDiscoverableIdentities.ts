import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives the member-directory identity filter something it is ALLOWED to read.
 *
 * ---------------------------------------------------------------------------
 * The bug this fixes, and the fix that would have been worse
 * ---------------------------------------------------------------------------
 * `MemberDirectoryFilterPage` sends its identity selections to
 * `GET /members?tags=`, and `ProfilesService.searchMembers` filters
 * `p.tags && :tags`. But `profiles.tags` holds SKILLS — 'Illustration',
 * 'NestJS', 'Print'. The two vocabularies have never intersected, so in live
 * mode every identity selection returns zero members. The filter has never
 * worked.
 *
 * The obvious repair is to point that query at `profiles.identities`, which
 * already holds exactly the right words. Do not do this. `identities` is
 * documented on the entity as "never shown on the public profile, only returned
 * to the owner", and `toFullProfile` gates it behind `isOwner` for that reason.
 * Filtering on it would make every member enumerable by sexual orientation,
 * gender history and health status — GDPR Article 9 special-category data — by
 * any signed-in member, on a platform people join BECAUSE it is a safer place to
 * be known. Nobody consented to that when they filled in a private preferences
 * form. `identities` stays private and this migration does not touch it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ADDS: an opt-in, per-identity PUBLISHED subset
 * ---------------------------------------------------------------------------
 * `discoverable_identities` is the subset of `identities` a member has
 * explicitly chosen to be findable by. Default `'{}'` — off, for everyone,
 * forever, until the member says otherwise. There is no backfill and there
 * must never be one: a backfill IS the disclosure this whole design exists to
 * require consent for.
 *
 * PER-IDENTITY, not one blanket switch. Someone may be entirely happy to be
 * found as a lesbian and not at all happy to be found as disabled. A single
 * "make me discoverable" toggle collapses those two decisions into one and
 * would defeat the point of asking.
 *
 * ---------------------------------------------------------------------------
 * THE SUBSET INVARIANT IS A DATABASE CONSTRAINT
 * ---------------------------------------------------------------------------
 * `CHECK (discoverable_identities <@ identities)` — a published identity must
 * be one the member actually holds.
 *
 * This is enforceable in the database ONLY because both columns store the same
 * vocabulary (the Settings → Interests labels: 'Lesbian', 'Non-binary', …), and
 * that is why `src/profiles/identities.ts` stores labels here and translates the
 * directory's coarser facet ids (`transNonBinary`, `biPan`, …) to labels at
 * QUERY time. Storing facet ids instead would have made "published ⊆ private" a
 * cross-vocabulary claim no constraint could express, leaving it to be
 * re-remembered by every future write path. It is checked in the service too,
 * so a member gets a 422 rather than a 500 — but the constraint is what makes it
 * TRUE rather than merely usually-true.
 *
 * The subtle half is REMOVAL. A member who drops 'Disabled or chronically ill'
 * from their private identities must not leave it standing as published — that
 * is the exact opposite of what retracting a disclosure means. With this
 * constraint in place, failing to handle it is not a silent leak: the profile
 * UPDATE itself fails. `ProfilesService.updateMe` prunes
 * `discoverable_identities` down to the new `identities` in the same write, so
 * un-declaring an identity un-publishes it atomically. See `pruneDiscoverable`.
 *
 * A trailing CHECK for the closed vocabulary is deliberately NOT added. The
 * interest list is expected to grow, and freezing it into the schema would mean
 * a migration per new option — the same trade-off `trans_support` made in
 * AddProfileSafetyPreferences1782800760000. Range-checking belongs in the DTO
 * (`@IsIn(PUBLISHABLE_INTEREST_LABELS, { each: true })`); containment within the
 * member's own declarations is the part that must be structural.
 *
 * ---------------------------------------------------------------------------
 * NO GIN INDEX (yet)
 * ---------------------------------------------------------------------------
 * The `&&` overlap test the directory runs can use a GIN index, and
 * AddPerformanceIndexes1782692700000 sets the precedent for adding them. Not
 * doing it here: this column is empty for every existing member and will stay
 * sparse by design, so the planner's sequential scan over `profiles` — already
 * filtered by `users.status = 'active'` and the block filter — is the cheaper
 * plan until real usage says otherwise. Recorded so the next person knows it
 * was considered rather than forgotten.
 */
export class AddDiscoverableIdentities1782800770000 implements MigrationInterface {
  name = 'AddDiscoverableIdentities1782800770000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD "discoverable_identities" text array NOT NULL DEFAULT '{}'`,
    );

    // Named explicitly so `down()` can drop it by name and so a violation in
    // the logs points at the invariant rather than at an autogenerated hash.
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD CONSTRAINT "CHK_profiles_discoverable_subset"
         CHECK ("discoverable_identities" <@ "identities")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" DROP CONSTRAINT "CHK_profiles_discoverable_subset"`,
    );
    await queryRunner.query(
      `ALTER TABLE "profiles" DROP COLUMN "discoverable_identities"`,
    );
  }
}

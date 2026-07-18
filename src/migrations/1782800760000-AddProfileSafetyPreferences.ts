import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives the member SAFETY and VISIBILITY switches somewhere to live.
 *
 * ---------------------------------------------------------------------------
 * The bug this fixes
 * ---------------------------------------------------------------------------
 * Two frontend providers held these settings in `useState` and nothing else:
 * `WorkProfileProvider.tsx` (out-at-work spectrum, trans-support selections,
 * safe-employers-only) and `PublicProfileProvider.tsx` (is my profile
 * published). Both render a success state on save and persist nothing, so a
 * reload silently reverts them.
 *
 * That is a different class of bug from a theme toggle losing its value. One of
 * these settings is how out a member is at work; the other is whether their
 * profile is on the open web. A member who sets "private", sees the
 * confirmation, and comes back tomorrow to find "verified" has been told
 * something false about their own disclosure.
 *
 * ---------------------------------------------------------------------------
 * STORAGE DECISION: a new `member_preferences` table, not columns on `profiles`
 * ---------------------------------------------------------------------------
 * Both precedents were considered:
 *
 *   - `profiles` (`src/users/entities/profile.entity.ts`) already carries
 *     owner-only fields — `identities`, `lookingFor` — so there IS precedent
 *     for putting private data there.
 *   - `email_preference` (`AddAccountManagement1782800030000`) is a separate
 *     per-(user, category) override table.
 *
 * Chose a separate table, for two reasons.
 *
 * 1. BLAST RADIUS. `profiles` is loaded by every profile read path in the app:
 *    `toFullProfile`, `toMemberCard`, `toLimitedProfile`, `loadRelated` and
 *    `searchMembers` all select the whole row and hand it to a serialiser that
 *    runs for OTHER members. TypeORM selects every column by default, so a
 *    sensitive column added there is one careless spread or one new field in
 *    `toMemberCard` away from being served to the wrong person. The only thing
 *    protecting `identities`/`lookingFor` today is a comment on the entity.
 *    That is an acceptable guard for "interests"; it is not an acceptable guard
 *    for outness disclosure. A separate table that no other query joins makes
 *    "this never leaves the owner's own request" a structural property rather
 *    than a convention someone has to remember.
 *
 * 2. LIFECYCLE. These are settings, not profile content. `profiles` describes
 *    what a member shows the community; this describes how the product must
 *    behave toward them. They are also read on completely different pages
 *    (Work Profile, Jobs, Public Profile settings) from the profile itself.
 *
 * Did NOT follow the `email_preference` shape either. That table models a
 * SPARSE set of overrides against an open-ended category list, so it needs a
 * surrogate id and a (user, category) unique index. This is a fixed, singleton
 * set of four settings per member, so it takes the `profiles` idiom instead:
 * `user_id` as BOTH primary key and FK. That makes "at most one row per member"
 * a primary key rather than an index, and makes the upsert in
 * `PreferencesService` trivially correct.
 *
 * Both endpoints share the row, and each writes only its own columns — see
 * `updateWorkPreferences` / `updatePublicProfile`, which merge onto the loaded
 * row precisely so they cannot clobber each other.
 *
 * ---------------------------------------------------------------------------
 * NO BACKFILL — absence is a meaningful state
 * ---------------------------------------------------------------------------
 * Existing members get no row. `PreferencesService.loadOrDefault` synthesises
 * `{verified, [], true}` / `{enabled:false}` on read instead of 404ing, and a
 * row is inserted only on first write. Backfilling a row per member would be
 * pure write amplification for identical values, and would also destroy the
 * ability to tell "member has never touched this" from "member deliberately
 * chose the default" — a distinction worth keeping for a safety setting. The
 * column defaults below are kept in lockstep with the constants in
 * `member-preferences.entity.ts` so both paths agree.
 *
 * ---------------------------------------------------------------------------
 * `out_at_work` is a Postgres enum type, not a varchar
 * ---------------------------------------------------------------------------
 * Matching how `profiles.visibility` constrains its closed set
 * (`profiles_visibility_enum`, created in `Init1782691200000`) rather than the
 * varchar + `@IsIn` pattern used for open-ended vocabularies. The three values
 * are a fixed spectrum owned by this backend, so the database should reject a
 * fourth — validation at the DTO alone would let a direct SQL write or a future
 * service bypass store a value the client cannot render.
 *
 * `trans_support` is `text[] DEFAULT '{}'` instead, mirroring
 * `profiles.identities` / `profiles.lookingFor`: it is a multi-select whose
 * option list belongs to the frontend catalogue and is expected to grow, so it
 * is range-checked by `@IsIn(TRANS_SUPPORT_IDS, {each:true})` in the DTO
 * (the same choice `open_to` makes) rather than frozen into a DB type that
 * would need a migration per new option.
 *
 * ---------------------------------------------------------------------------
 * 🔴 `public_profile_enabled` IS INERT TODAY
 * ---------------------------------------------------------------------------
 * This column stores intent and nothing more. No read path in this backend
 * consults it, and there is no unauthenticated profile endpoint for it to gate
 * — every profile read sits behind the global `JwtAuthGuard` plus
 * `ActiveMemberGuard`, and none of the app's `@Public()` routes serve profile
 * data. Setting it to `true` therefore changes nothing about who can see the
 * member's profile.
 *
 * This migration deliberately does not build that public read path. It is
 * recorded here, and on the column itself, so the next person does not mistake
 * a persisted flag for an enforced one: a flag no read path honours is still a
 * lie, just a durable one. Whoever adds a public profile endpoint must make
 * this its gate, combined with — never substituted for — `profiles.visibility`.
 */
export class AddProfileSafetyPreferences1782800760000 implements MigrationInterface {
  name = 'AddProfileSafetyPreferences1782800760000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "member_preferences_out_at_work_enum"
        AS ENUM('out', 'verified', 'private')
    `);

    await queryRunner.query(`
      CREATE TABLE "member_preferences" (
        "user_id" uuid NOT NULL,
        "out_at_work" "member_preferences_out_at_work_enum" NOT NULL DEFAULT 'verified',
        "trans_support" text array NOT NULL DEFAULT '{}',
        "safe_only" boolean NOT NULL DEFAULT true,
        "public_profile_enabled" boolean NOT NULL DEFAULT false,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_member_preferences" PRIMARY KEY ("user_id")
      )
    `);

    // No separate index on user_id: it is the primary key, which already backs
    // the only lookup this table has (`findOne({ where: { userId } })`).
    // ON DELETE CASCADE — these settings describe a member and are meaningless
    // without them; erasure must take them too (cf. the deletion/erasure work
    // in AddDeletionErasureSupport1782800700000).
    await queryRunner.query(`
      ALTER TABLE "member_preferences" ADD CONSTRAINT "FK_member_preferences_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_preferences" DROP CONSTRAINT "FK_member_preferences_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "member_preferences"`);
    await queryRunner.query(`DROP TYPE "member_preferences_out_at_work_enum"`);
  }
}

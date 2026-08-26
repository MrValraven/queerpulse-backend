import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends `FixCommunityOwnerAuthorErasureCascades1789900000000` from
 * Communities to every other place where one member's account erasure was
 * silently deleting content OTHER people depend on.
 *
 * The communities migration called its case "the single most consequential
 * finding". The identical bug was still live across gatherings, the business
 * and housing directories, jobs, volunteering, companies, reviews and
 * safe-space nominations: each of those tables carries an actor FK to
 * `users("id")` declared `ON DELETE CASCADE`, so erasing one account deleted
 * every gathering that member ever hosted (including future ones, with
 * everybody's RSVPs), every listing they submitted, and every review they
 * wrote, with no notice to anyone counting on them.
 *
 * The eleven FKs converted here, and why each one is content that outlives
 * its author:
 *
 *  - `events.host_id`            a gathering other members RSVP'd to
 *  - `event_series.host_id`      the repeat rule behind those gatherings
 *  - `workshops.host_id`         a workshop other members booked
 *  - `listings.owner_id`         a business directory entry about a real venue
 *  - `housing_listings.owner_id` a home other members viewed and reviewed
 *  - `jobs.poster_id`            a role other members applied to
 *  - `volunteer_opportunities.poster_id` a shift other members signed up for
 *  - `companies.owner_id`        a company profile with its own team and jobs
 *  - `company_reviews.author_id` a review the next applicant reads
 *  - `housing_reviews.author_id` a review the next tenant reads
 *  - `safe_space_nominations.nominator_id` a nomination in the moderation queue
 *
 * Deliberately left `ON DELETE CASCADE`, because the row genuinely has no
 * meaning without the member and cascading is equivalent to them having
 * withdrawn: every join/participation row (`event_rsvps`, `event_cohosts`,
 * `event_invites`, `event_bookmarks`, `workshop_rsvps`, `volunteer_signups`,
 * `volunteer_opportunity_team`, `job_applications`, `company_team_members`,
 * `community_members`, `connections`, `topic_follows`), every private or
 * preference row (`email_preference`, `push_subscriptions`,
 * `cinema_watch_progress`, `member_verifications`, `flatmate_profiles`,
 * `account_reauth_token`, `data_export_job`), everything addressed to the
 * member (`notifications`), and `housing_reviews.subject_id` (a review ABOUT
 * the erased member, which erasure should take with it).
 *
 * Every affected column becomes nullable first, since a `SET NULL` rule on a
 * `NOT NULL` column is a constraint Postgres accepts at DDL time and only
 * fails on at delete time.
 *
 * Purely transactional: no `CREATE INDEX CONCURRENTLY` here. Each column
 * already carries its own index from the migration that created it, and
 * `ALTER COLUMN ... DROP NOT NULL` leaves those indexes in place.
 *
 * Paired application code: `ContentOwnerErasureService`
 * (`src/account/content-owner-erasure.service.ts`), called from
 * `AccountDeletionProcessorService.eraseAccount` BEFORE the user row is
 * deleted, hands future gatherings to a co-host or cancels them with an
 * `EventCancelled` fan-out, and closes the erased member's open jobs,
 * volunteering and housing listings instead of leaving them live with nobody
 * to answer them.
 *
 * DO NOT RUN. Authored for review only; the maintainer runs migrations.
 */
export class SetNullContentAuthorFksOnUserErasure1794610000000 implements MigrationInterface {
  name = 'SetNullContentAuthorFksOnUserErasure1794610000000';

  /**
   * `[table, column, constraint]` for every FK this migration flips from
   * `ON DELETE CASCADE` to `ON DELETE SET NULL`. Driving both directions off
   * one list keeps `up()` and `down()` from drifting apart; `down()` walks it
   * in reverse so the schema unwinds in the order it was built.
   */
  private static readonly CONVERTED_FOREIGN_KEYS: ReadonlyArray<
    readonly [table: string, column: string, constraint: string]
  > = [
    ['events', 'host_id', 'FK_events_host_id'],
    ['event_series', 'host_id', 'FK_event_series_host_id'],
    ['workshops', 'host_id', 'FK_workshops_host_id'],
    ['listings', 'owner_id', 'FK_listings_owner_id'],
    ['housing_listings', 'owner_id', 'FK_housing_listings_owner_id'],
    ['jobs', 'poster_id', 'FK_jobs_poster_id'],
    [
      'volunteer_opportunities',
      'poster_id',
      'FK_volunteer_opportunities_poster_id',
    ],
    ['companies', 'owner_id', 'FK_companies_owner_id'],
    ['company_reviews', 'author_id', 'FK_company_reviews_author_id'],
    ['housing_reviews', 'author_id', 'FK_housing_reviews_author_id'],
    [
      'safe_space_nominations',
      'nominator_id',
      'FK_safe_space_nominations_nominator_id',
    ],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [
      table,
      column,
      constraint,
    ] of SetNullContentAuthorFksOnUserErasure1794610000000.CONVERTED_FOREIGN_KEYS) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP NOT NULL`,
      );
      await queryRunner.query(`
        ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}"
          FOREIGN KEY ("${column}") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Same caveat as `FixCommunityOwnerAuthorErasureCascades1789900000000`'s
    // down(): restoring NOT NULL only succeeds while no row has actually been
    // NULLed by an erasure. Once a host or author has been erased, `SET NOT
    // NULL` correctly fails rather than silently resurrecting an id that no
    // longer exists.
    const reversed = [
      ...SetNullContentAuthorFksOnUserErasure1794610000000.CONVERTED_FOREIGN_KEYS,
    ].reverse();
    for (const [table, column, constraint] of reversed) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" SET NOT NULL`,
      );
      await queryRunner.query(`
        ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}"
          FOREIGN KEY ("${column}") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      `);
    }
  }
}

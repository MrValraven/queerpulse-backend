// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Strips `payload.actorId` from every `listing_public_question_answered`
 * notification that names somebody the public listing page does not.
 *
 * THE LEAK THIS CLEANS UP. That row used to carry the answering member as
 * `payload.actorId` unconditionally, while the business page it was written
 * about names nobody: `ListingPublicQuestionDTO` attributes an answer by ROLE
 * only, a co-manager is invisible on the public page by design
 * (`listing-owner-personal-fields.ts`), and an owner on `visibility: 'anon'` or
 * `'role'`, or one who withheld `linkToProfile`, has told this platform not to
 * tie their name to this business. So the asker's bell was handing out a name,
 * a face and a profile link that the page they asked on deliberately withholds,
 * which on this platform outs a queer business owner. The write path now spreads
 * `actorId` only where `isOwnerPubliclyNamed` (`listings/listing-response.ts`,
 * the same predicate the public page is built from) says the page already links
 * that owner's profile.
 *
 * WHY THE ROWS ALREADY WRITTEN NEED A MIGRATION rather than time.
 * `NotificationRetentionService` deletes only rows that have been READ, past its
 * retention window; an UNREAD row is never deleted, so an unread leaking row
 * would sit in the recipient's bell indefinitely. Nothing else ages them out,
 * and `actorIdOf` resolves the name fresh on every read, so the leak is live for
 * as long as the row is.
 *
 * FAIL CLOSED, which is why this is a `NOT EXISTS` rather than a join to the
 * offending listings. `actorId` survives only where a listing can be found for
 * the row's `listingSlug` AND that listing's owner IS the actor AND the page
 * publicly names them. Everything else is stripped, including the cases a
 * positive join would have silently skipped:
 *
 *  - THE LISTING HAS SINCE BEEN DELETED. A row joined to nothing matches no
 *    `FROM listings` predicate, so an inner join would leave the actor in place
 *    on exactly the rows nobody can check any more. Here it strips, because a
 *    listing that no longer exists cannot be publishing anyone's name.
 *  - `owner_id IS NULL`, the listing's owner having erased their account
 *    (`SetNullContentAuthorFksOnUserErasure1794610000000` made that FK
 *    `ON DELETE SET NULL`). Nobody is named on that page either.
 *  - A CO-MANAGER answered: `owner_id` is somebody else, so the equality fails
 *    and the actor goes. This is the case the `isOwnerPubliclyNamed` check alone
 *    would not have caught, because the LISTING may be perfectly public while
 *    the person who answered is not named on it.
 *  - A MODERATOR answered. Those rows never carried an `actorId` to begin with,
 *    so they are already excluded by the `jsonb_exists` test.
 *
 * `jsonb_exists(payload, 'actorId')` rather than the `?` operator it is the
 * function form of: `?` is also a parameter placeholder in several drivers, and
 * a raw migration string is not the place to depend on which one wins. Same
 * semantics, no ambiguity. `payload` is `jsonb`, so `-` deletes the key (on
 * `json` it would not exist at all), and re-running the statement is a no-op
 * because the `jsonb_exists` test is then false. `bundle_key` cannot desync:
 * `subjectFor` in `notification-bundling.ts` returns `null` for this type, so
 * these rows are never bundled and their key is always NULL.
 *
 * The row stays USEFUL after the strip. `listingName`, `source` and
 * `listingSlug` all remain, so the copy still reads and the deep link still
 * opens the page the answer is published on. Only the name comes off, which is
 * the part the asker was never owed.
 *
 * `down()` IS A NO-OP, and honestly so: this deletes the only copy of those ids
 * that existed. There is nothing left to restore them from, and there should
 * not be. Reverting this migration reverts the code and leaves the redaction in
 * place, the same position `BackfillListingCityAndTimezone1794800000000` takes
 * for the same reason.
 *
 * FULLY TRANSACTIONAL. One `UPDATE`, no DDL.
 */
export class StripWithheldActorFromListingQuestionAnsweredNotifications1797600000000 implements MigrationInterface {
  name =
    'StripWithheldActorFromListingQuestionAnsweredNotifications1797600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "notifications" AS n
          SET "payload" = n."payload" - 'actorId'
        WHERE n."type" = 'listing_public_question_answered'
          AND jsonb_exists(n."payload", 'actorId')
          AND NOT EXISTS (
            SELECT 1
              FROM "listings" AS l
             WHERE l."slug" = n."payload" ->> 'listingSlug'
               AND l."owner_id" IS NOT NULL
               AND l."owner_id"::text = n."payload" ->> 'actorId'
               AND l."visibility" NOT IN ('anon', 'role')
               AND l."link_to_profile" = true
          )`,
    );
  }

  public async down(): Promise<void> {
    // Intentionally empty; see the note above. The ids are gone.
  }
}

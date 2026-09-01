import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { CommunityOwnerOrphanService } from '../communities/community-owner-orphan.service';
import { DAY_MS, DELETION_FINAL_WARNING_LEAD_DAYS } from './account.constants';
import { MediaReferenceResolver } from '../media-references/media-reference.resolver';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { toBareKey } from '../storage/bare-key';
import { StorageService } from '../storage/storage.service';
import { ContentOwnerErasureService } from './content-owner-erasure.service';
import { User } from '../users/entities/user.entity';
import {
  EmailSuppression,
  hashSuppressedEmail,
} from './entities/email-suppression.entity';
import {
  DeletionRequest,
  DeletionRequestStatus,
} from './entities/deletion-request.entity';

// How many storage keys are reference-checked per `MediaReferenceResolver`
// call in step 4. Mirrors `StorageMaintenanceService`'s own batch size, for the
// same reason: the resolver's array sources run a `LIKE ANY` per candidate key,
// so an unbounded batch would build a pathological query.
const REFERENCE_CHECK_BATCH_SIZE = 200;

/**
 * Executes the right to erasure. `POST /account/deletion-request` only *writes*
 * a `grace` row scheduled 30 days out; this is the thing that eventually makes
 * the erasure real.
 *
 * Single-instance job — safe here because the app runs one scheduler; if we
 * scale out, move this behind a distributed lock or a dedicated worker. (The
 * per-row claim below already makes a double tick harmless, but every replica
 * doing the same scan is still wasted work.)
 */
@Injectable()
export class AccountDeletionProcessorService {
  private readonly logger = new Logger(AccountDeletionProcessorService.name);

  /** Answers "is this storage key still referenced by any DB row?" for step 4.
   *  Assigned in the constructor. See the note there for why it is built
   *  rather than injected. */

  constructor(
    @InjectRepository(DeletionRequest)
    private readonly deletionRequests: Repository<DeletionRequest>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    // Resolves an erased owner's communities to a new owner (or flags them
    // for admin review) — see the call site in `eraseAccount` for why this
    // has to run before the `User` row is deleted.
    private readonly communityOwnerOrphan: CommunityOwnerOrphanService,
    // Resolves the gatherings, jobs, volunteering and housing listings the
    // erased member left other people depending on, under the same ordering
    // requirement as `communityOwnerOrphan` above, for the same reason.
    private readonly contentOwnerErasure: ContentOwnerErasureService,
    // Sends the final warning below. `NotificationsModule` is already imported
    // by `AccountModule` (for `ContentOwnerErasureService`'s cancellation
    // fan-out), so this needs no new module wiring.
    private readonly notifications: NotificationsService,
    // Step 4 needs this to tell "nothing points at this object any more"
    // (delete it) from "a row that outlived the erasure still does" (keep it),
    // which is the distinction that stops the sweep destroying a gathering
    // photo whose row survives on `ON DELETE SET NULL`. Injected rather than
    // built by hand: constructing it directly worked only while the resolver's
    // sole dependency was the `DataSource` this service already holds, and
    // would break silently the day it gains another. `MediaReferencesModule`
    // does not import `AccountModule`, so this needs no `forwardRef`.
    private readonly mediaReferences: MediaReferenceResolver,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async processDueDeletions(): Promise<void> {
    // @nestjs/schedule does not wrap handlers, so an escaping rejection becomes
    // an unhandledRejection — which, absent a Sentry listener, takes the process
    // down. A DB blip must not restart the server; the next tick retries.
    try {
      await this.eraseDueAccounts();
    } catch (err) {
      this.logger.error(
        `Account erasure sweep failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
    // Warn AFTER erasing, in its own try: the two sweeps are independent, and a
    // failure to warn must never stop an erasure the member has a statutory
    // right to, nor the reverse. Running second also means a row that came due
    // on this very tick has already left `grace`, so nobody is warned about a
    // deletion that just happened.
    try {
      await this.warnUpcomingDeletions();
    } catch (err) {
      this.logger.error(
        `Account deletion warning sweep failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }

  /**
   * Tell a member their account is about to be deleted, while cancelling is
   * still possible. This is the emit site `NotificationType
   * .AccountDeletionFinalWarning` was defined for and never had: the grace
   * period ran silently for thirty days and the account simply vanished.
   *
   * Fires ONCE per member. The daily tick is what makes that the hard part, so
   * the row is CLAIMED first with a conditional UPDATE — `finalWarningSentAt IS
   * NULL` in the WHERE, exactly the shape `eraseDueAccounts` uses to claim a
   * `grace` row — and a run that loses the race sees `affected === 0` and skips.
   *
   * `daysRemaining` is a NUMBER, never a composed sentence: the frontend
   * mirrors it onto `count` and lets CLDR pick the plural in the member's own
   * language. It is rounded to whole days and floored at 1, so a row the sweep
   * reaches late reads "in 1 day" rather than "in 0 days".
   *
   * IN-APP (plus push). QueerPulse sends no email, so nothing here is described
   * as one.
   */
  private async warnUpcomingDeletions(): Promise<void> {
    const now = new Date();
    const warningHorizon = new Date(
      now.getTime() + DELETION_FINAL_WARNING_LEAD_DAYS * DAY_MS,
    );
    const upcoming = await this.deletionRequests.find({
      where: {
        status: DeletionRequestStatus.Grace,
        // Inside the lead window, and not already due — a due row belongs to
        // the erasure sweep above, not to a countdown.
        scheduledFor: LessThanOrEqual(warningHorizon),
        finalWarningSentAt: IsNull(),
      },
    });
    for (const request of upcoming) {
      if (request.scheduledFor.getTime() <= now.getTime()) {
        continue;
      }
      const claim = await this.deletionRequests.update(
        {
          id: request.id,
          status: DeletionRequestStatus.Grace,
          finalWarningSentAt: IsNull(),
        },
        { finalWarningSentAt: now },
      );
      if (claim.affected !== 1) {
        continue;
      }
      const daysRemaining = Math.max(
        1,
        Math.round((request.scheduledFor.getTime() - now.getTime()) / DAY_MS),
      );
      try {
        await this.notifications.create(
          request.userId,
          NotificationType.AccountDeletionFinalWarning,
          { source: 'account', daysRemaining },
        );
      } catch (err) {
        // The claim stands. Re-warning on tomorrow's tick would mean dropping
        // the marker, which reopens the double-send this column exists to
        // close; the member still sees the countdown on the delete-account page
        // the notification would have linked them to.
        this.logger.error(
          `Deletion request ${request.id} was claimed for its final warning but notifying failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      }
    }
  }

  private async eraseDueAccounts(): Promise<void> {
    const now = new Date();
    const due = await this.deletionRequests.find({
      where: {
        status: DeletionRequestStatus.Grace,
        scheduledFor: LessThanOrEqual(now),
      },
    });
    for (const request of due) {
      // Claim the request *before* erasing. The conditional UPDATE only moves a
      // row that is still `grace`, so a concurrent run (or an overlapping tick)
      // that loses the race sees affected === 0 and skips — one account is never
      // erased twice, and a member who cancelled in the same instant (status
      // flipped to `cancelled`) can no longer be claimed at all.
      const claim = await this.deletionRequests.update(
        { id: request.id, status: DeletionRequestStatus.Grace },
        { status: DeletionRequestStatus.Processing },
      );
      if (claim.affected !== 1) {
        continue;
      }
      // Isolate each account: one erasure failing must not strand the rest of
      // the batch. A failure leaves the row parked in `processing` rather than
      // reverting it to `grace` — it is deliberately NOT auto-retried, because
      // a half-applied erasure needs a human to look at it, and `processing` is
      // the state the frontend already renders for "in progress".
      try {
        await this.eraseAccount(request.userId);
        await this.deletionRequests.update(
          { id: request.id },
          {
            status: DeletionRequestStatus.Erased,
            processedAt: new Date(),
          },
        );
        this.logger.log(`Erased account for deletion request ${request.id}`);
      } catch (err) {
        this.logger.error(
          `Erasure failed for deletion request ${request.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      }
    }
  }

  /**
   * Erase one member, in a single transaction so we never leave an account
   * half-erased (e.g. moderation history pseudonymized but the user row still
   * present, or worse, the reverse).
   *
   * Order matters:
   *  1. suppress the email — must be read off the user row *before* it is gone;
   *  2. pseudonymize the moderation history we are keeping;
   *  3. delete the user row, which cascades every member-owned DB row away
   *     (member-owned: content other members depend on is `ON DELETE SET NULL`
   *     and survives with a null byline).
   *
   * Then, AFTER the transaction commits, erase the member's uploaded bucket
   * objects that nothing references any more (step 4), keeping the ones a row
   * that outlived the erasure still points at. This lives outside the
   * transaction on purpose, and adds no DB write of its own. See the comment
   * there.
   *
   * BEFORE any of that, resolve community ownership and the content other
   * members depend on (step 0) — see the calls below.
   */
  private async eraseAccount(userId: string): Promise<void> {
    // 0. Resolve any community ownership BEFORE the user row is deleted.
    //    `communities.owner_id` is `ON DELETE SET NULL`
    //    (`FixCommunityOwnerAuthorErasureCascades1789900000000`) — once step 3
    //    below runs, the FK has already blanked `owner_id` and there is no way
    //    left to tell who used to own what, which is exactly what
    //    `CommunityOwnerOrphanService.handleOwnerErasure`'s docstring warns
    //    about ("MUST be called BEFORE that `manager.delete(User, ...)`
    //    statement runs").
    //
    //    NOT inside the transaction below: `CommunityOwnerOrphanService` does
    //    not accept an external `EntityManager`/query-runner (by its own
    //    design note), so as written it opens and commits its own
    //    transaction per orphaned community. Calling it here, before this
    //    method's own transaction even opens, keeps the two from overlapping
    //    and still guarantees the required ordering. The trade-off: these are
    //    two separate commits, not one atomic unit. If the transaction below
    //    then fails for an unrelated reason, the owner reassignment already
    //    committed here is NOT rolled back — but that's safe to leave, not
    //    just tolerated: `eraseDueAccounts` parks a failed row in `processing`
    //    for a human to retry rather than auto-retrying, and a retry's call to
    //    `handleOwnerErasure` is naturally idempotent (it only ever acts on
    //    communities still owned by `userId`, so a second call for the same
    //    user finds nothing left to do).
    await this.communityOwnerOrphan.handleOwnerErasure(userId);

    // 0b. Resolve the CONTENT other members depend on, for the same reason and
    //     under the same ordering rule. Every content-actor FK this touches
    //     (`events.host_id`, `event_series.host_id`, `jobs.poster_id`,
    //     `volunteer_opportunities.poster_id`, `housing_listings.owner_id`) is
    //     `ON DELETE SET NULL` as of
    //     `SetNullContentAuthorFksOnUserErasure1794610000000`, so once step 3
    //     runs there is no way left to tell which gatherings this member was
    //     hosting. `ContentOwnerErasureService.eraseFor` hands each future
    //     gathering to a co-host or cancels it with an `EventCancelled`
    //     fan-out to everyone holding an RSVP, and closes the open postings
    //     nobody is left to answer.
    //
    //     Outside the transaction for the same reason `handleOwnerErasure` is:
    //     it commits per step and its notification fan-out must run against
    //     committed state. Every step is idempotent (each matches only rows
    //     still attributed to `userId` AND still in the state that needs
    //     changing), so the retry path `eraseDueAccounts` leaves open is safe.
    await this.contentOwnerErasure.eraseFor(userId);

    await this.dataSource.transaction(async (manager) => {
      // `addSelect('user.email')` re-includes the `select: false` email column:
      // the suppression row is keyed on `hashSuppressedEmail(user.email)`, so an
      // unloaded email here would hash `undefined` and let the erased account
      // silently re-register on the same address.
      const user = await manager
        .createQueryBuilder(User, 'user')
        .addSelect('user.email')
        .where('user.id = :userId', { userId })
        .getOne();
      if (!user) {
        // Already gone (manual DB surgery, or a prior partial run that got as
        // far as the delete). Nothing to erase — treat as success so the
        // request row can be stamped `erased` rather than retried forever.
        this.logger.warn(
          `Deletion request for ${userId} found no user row; treating as already erased`,
        );
        return;
      }

      // 1. Email suppression — "so we don't accidentally re-create your
      //    account". Idempotent: a re-run (or a member who somehow has two
      //    erased accounts on one address) must not trip the unique index.
      await manager
        .createQueryBuilder()
        .insert()
        .into(EmailSuppression)
        .values({
          emailHash: hashSuppressedEmail(user.email),
          reason: 'account_deleted',
        })
        .orIgnore()
        .execute();

      // 2. Preserve moderation history by severing it from the person, not by
      //    deleting it. Reports this member filed AGAINST OTHERS have to
      //    survive — otherwise erasing your account is a way to delete the
      //    evidence trail against everyone you ever reported. Same for the
      //    moderator action log: an erased moderator must not take the record
      //    of their decisions with them.
      //
      //    The FKs are `ON DELETE SET NULL` as of
      //    `AddDeletionErasureSupport1782800700000`, so step 3 would do this
      //    anyway; doing it explicitly here makes the intent legible and keeps
      //    the guarantee even if someone later "tidies" the FK rule back.
      await manager.query(
        `UPDATE "reports" SET "reporter_id" = NULL WHERE "reporter_id" = $1`,
        [userId],
      );
      await manager.query(
        `UPDATE "mod_audit_logs" SET "actor_id" = NULL WHERE "actor_id" = $1`,
        [userId],
      );

      // 3. Hard-delete the user. Every other member-owned table carries an
      //    `ON DELETE CASCADE` FK to `users("id")` and goes with it — 70+ FKs
      //    across the schema, verified against `src/migrations`.
      //
      //    NOTE for the next person: an earlier version of this brief claimed
      //    `activities`, `board_posts`, `shapings`, `skills` and
      //    `group_memberships` have NO FK to `users` and would be silently
      //    orphaned. That is NOT true — `AddProfileRichDetail1782692500000`
      //    adds `FK_<table>_user_id ... ON DELETE CASCADE` for all five in a
      //    loop (which is why a grep for their literal constraint names finds
      //    nothing). They cascade correctly; no explicit delete is needed, and
      //    adding one would imply a missing FK that is in fact present.
      //
      //    Eleven of those FKs are no longer CASCADE: as of
      //    `SetNullContentAuthorFksOnUserErasure1794610000000`, content other
      //    members depend on (gatherings, directory and housing
      //    listings, jobs, volunteering, companies, reviews, safe-space
      //    nominations) is `ON DELETE SET NULL` and survives this delete with
      //    a NULL byline. Step 0b above is what makes that survival sensible
      //    rather than merely non-destructive.
      //
      //    `deletion_request` itself is the one table that must NOT cascade —
      //    its FK was dropped in the same migration so this erasure ledger
      //    survives the row it describes.
      //
      //    UPDATE 2026-08-31. "Every other member-owned table carries an FK"
      //    was an assumption, and a deep scan found nine columns where it was
      //    false. Those rows survived an erasure keyed to a dead user id:
      //    `flatmate_likes.from_user_id` (who you liked or passed),
      //    `housing_saved_searches.member_id` (named searches and criteria),
      //    `media_crops.owner_id`, `housing_reviews_superseded.author_id` and
      //    `.subject_id` (archived review text), `community_tag_request`'s two
      //    actor columns, and the magazine desk's comment, version and message
      //    authors. Four migrations in the `1795800000000`-`1795811000000` band
      //    close them, each deleting the already-unreachable orphans first so
      //    `ADD CONSTRAINT` can succeed.
      //
      //    They are not all CASCADE, and the split follows the rule step 2 and
      //    `SetNullContentAuthorFksOnUserErasure1794610000000` already set:
      //    a member-private artefact goes with the member, and something other
      //    people are part of stays with a NULL byline. So the likes, searches,
      //    crops, archived reviews, tag requests and private desk messages
      //    cascade; the editorial comment and article version null out and read
      //    as `FORMER_MEMBER_COMMENT_AUTHOR_LABEL`, which is why
      //    `magazine_article_comment.author_id` had to become nullable.
      //
      //    The count is therefore no longer worth quoting from memory. Derive
      //    it when you need it rather than trusting the number above.
      await manager.delete(User, { id: userId });
    });

    // 4. Erase the member's uploaded objects from bucket storage (audit §B P1),
    //    EXCEPT the ones a DB row that OUTLIVED the erasure still points at.
    //
    //    CORRECTION 2026-08-31. What stood here claimed the DB columns that
    //    referenced these objects "were cascaded away above", and named
    //    gathering photos among them. That was false, and acting on it broke
    //    real albums. `event_photos.uploader_id` is `ON DELETE SET NULL`
    //    (`AddEventPhotoAndFeaturedCommunityForeignKeys1785001300000`, and the
    //    entity's own note), so the row SURVIVES step 3 with a null uploader
    //    while a blanket prefix sweep deleted the object underneath it: a tile
    //    in a gathering album that can never load again. The same split hit
    //    every other `SET NULL` content type that carries media (see
    //    `SetNullContentAuthorFksOnUserErasure1794610000000`): a business
    //    listing's gallery, a housing listing's photos, a community's cover and
    //    avatar, a group conversation's photo, a listing review's photo, a
    //    landlord photo, a past gathering's cover.
    //
    //    THE DECISION, so it can be overruled deliberately rather than by
    //    accident. Two fixes were coherent: delete the surviving rows to match
    //    the object deletion, or stop deleting objects a surviving row needs.
    //    This takes the second, because it is the one the rest of the codebase
    //    has already settled on:
    //      - `SetNullContentAuthorFksOnUserErasure1794610000000` moved eleven
    //        content FKs off CASCADE precisely so erasing one member does not
    //        destroy what other members rely on. Reviews, listings and
    //        gatherings keep their text and lose their byline. A photograph is
    //        the same kind of contribution as the review text beside it.
    //      - The old comment here already stated that a gathering photo taken
    //        by SOMEONE ELSE that depicts the erased member survives. Keeping
    //        the photos of them while destroying the photos they took of other
    //        people is an accident of key prefixes rather than a position
    //        anyone chose.
    //      - Deleting a bucket object anywhere else in this codebase means
    //        proving nothing references it first: `StorageMaintenanceService`
    //        (the orphan sweep), `MyMediaService` and `AdminMediaService` all
    //        run `MediaReferenceResolver` and all REFUSE to delete when it
    //        reports `degraded`. Erasure was the one delete path that skipped
    //        the check. It no longer does.
    //    So: an object nothing points at any more (the avatar and work images
    //    whose rows cascaded away, replaced media, presigned-then-abandoned
    //    uploads with no DB row) is deleted, which is the whole privacy point
    //    of this step. An object a surviving row still points at is kept, and
    //    that row reads as a removed member, exactly as its text does.
    //
    //    NO DB WRITE HAPPENS HERE, so there is nothing that can half-apply and
    //    nothing to move inside the transaction above. The reference check has
    //    to run against COMMITTED post-cascade state anyway: asked inside the
    //    transaction it would still see the rows step 3 is about to remove and
    //    would keep their objects forever.
    //
    //    Runs AFTER the transaction commits, never inside it: object deletion is
    //    not transactional, so deleting first and then having the DB transaction
    //    roll back would wipe a still-live member's files. Best-effort — a
    //    storage failure is logged, not thrown, so it cannot strand the
    //    already-committed DB erasure back in `processing`; the legally-critical
    //    record removal has happened, and a residual object is a storage-cost
    //    item an operator (or the nightly orphan sweep) can clear. Correctness
    //    is unaffected.
    try {
      await this.eraseUnreferencedStorageObjects(userId);
    } catch (err) {
      this.logger.error(
        `Storage object erasure failed for account ${userId} (DB erasure already committed): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }

  /**
   * Delete every bucket object this member uploaded that nothing references any
   * more, and KEEP the ones a row that outlived the erasure still points at.
   * See step 4 in `eraseAccount` for why that split is the right one.
   *
   * Enumerates the same per-kind prefixes (`<kind>/<userId>/…`) that
   * `StorageService.deleteUserObjects` sweeps, so abandoned presigned uploads
   * with no DB row are still caught. It does not reach objects OTHER members
   * uploaded that happen to depict this person; those are keyed to their own
   * uploader and out of scope.
   *
   * `degraded` is honoured the way every other delete path in the codebase
   * honours it (`StorageMaintenanceService.orphansInBatch`, `MyMediaService`,
   * `AdminMediaService`): a reference set that could not be fully computed is
   * never a green light to delete. The batch is kept instead. Keeping an object
   * too long is recoverable by a later run or the nightly orphan sweep;
   * deleting one a live row needs is permanent.
   *
   * Per-object failures are counted rather than thrown, so one unhappy key
   * cannot leave the rest of a member's uploads behind.
   */
  private async eraseUnreferencedStorageObjects(userId: string): Promise<void> {
    const objects = await this.storage.listUserObjects(userId);
    if (objects.length === 0) {
      return;
    }

    let deletedCount = 0;
    let retainedCount = 0;
    let failedCount = 0;

    for (
      let start = 0;
      start < objects.length;
      start += REFERENCE_CHECK_BATCH_SIZE
    ) {
      const batch = objects.slice(start, start + REFERENCE_CHECK_BATCH_SIZE);
      const resolution = await this.mediaReferences.resolve(
        batch.map((object) => toBareKey(object.key)),
      );
      if (resolution.degraded) {
        retainedCount += batch.length;
        this.logger.warn(
          `Media-reference resolution degraded while erasing account ${userId}; ` +
            `kept ${batch.length} object(s) rather than risk deleting one a live row still uses.`,
        );
        continue;
      }
      for (const object of batch) {
        if (resolution.references.has(toBareKey(object.key))) {
          retainedCount += 1;
          continue;
        }
        try {
          await this.storage.deleteObjectByKey(object.key);
          deletedCount += 1;
        } catch (err) {
          failedCount += 1;
          this.logger.error(
            `Could not erase storage object ${object.key} for account ${userId}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
          );
        }
      }
    }

    this.logger.log(
      `Erased ${deletedCount} storage object(s) for account ${userId}; ` +
        `kept ${retainedCount} still referenced by content that outlived the account` +
        (failedCount > 0 ? `; ${failedCount} could not be deleted` : ''),
    );
  }
}

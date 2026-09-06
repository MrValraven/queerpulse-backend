import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { runWithConcurrency } from '../common/run-with-concurrency';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { SubprofileFollower } from './entities/subprofile-follower.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';

/**
 * The most followers one publish will ever notify. Mirrors
 * `POST_NOTIFY_MAX_RECIPIENTS` in `community-posts.service.ts`: a bound, not a
 * quota, sized far above any real persona's audience so nothing is silently
 * dropped today, while a table that grows unexpectedly can never turn one
 * section save into an unbounded write.
 */
const UPDATE_NOTIFY_MAX_RECIPIENTS = 5000;

/**
 * Recipients per `createForRecipients` call. Each chunk is ONE multi-row
 * INSERT plus a handful of batched filter queries, so this is the unit of work
 * the pool below schedules.
 */
const UPDATE_NOTIFY_CHUNK_SIZE = 500;

/**
 * How many chunks may be in flight at once.
 *
 * Small on purpose: every chunk holds a database connection for its INSERT and
 * its filter queries, and `DATABASE_POOL_MAX` defaults to 10 on a
 * single-replica backend, so a fan-out that claimed more would starve every
 * unrelated request sharing that pool. Three keeps the pipeline full while
 * leaving most of the pool for the members actually using the site.
 */
const UPDATE_NOTIFY_MAX_CONCURRENT_CHUNKS = 3;

/**
 * "Somebody you follow published something new" (PRD-208), the half of
 * following that reaches the FOLLOWER.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS AN UPDATE
 * ---------------------------------------------------------------------------
 * One thing: a persona's content section GREW. New work went up, on a persona
 * that is live (published, open visibility, not owner-removed), and that is
 * what a follower said yes to.
 *
 * The growth test is the count, and it is deliberately the conservative
 * spelling. `replaceSection` posts a whole section at a time and the incoming
 * items carry no ids, so the only identity an item has across a save is its
 * position and its title. Requiring the count to rise means:
 *  - an EDIT (a fixed typo, a new date, a swapped image) sends nothing,
 *  - a REORDER sends nothing (`replaceSection` already detects that case for
 *    its own revision history, and this test never sees it either way),
 *  - a RETITLE sends nothing, where a title-only diff would have read it as
 *    new work,
 *  - swapping one item out for another in the same save sends nothing, which
 *    is a miss, and the right direction to miss in: a notification nobody
 *    asked for costs more than one that never fired.
 *
 * Also NOT an update, each for its own reason:
 *  - **The `links` section.** A social link is housekeeping, not work.
 *  - **The persona's own name, tagline, avatar, cover, availability or
 *    affiliations.** Maintenance of the page, not something published on it.
 *  - **Publishing or unpublishing the persona itself.** The follow is to a
 *    live persona; its lifecycle is the owner's business.
 *  - **Anything on a persona that is not currently live.** A draft's edits
 *    reach nobody, and neither do a `network`/`private` persona's: those are
 *    exactly the states the public read path withholds.
 *
 * ---------------------------------------------------------------------------
 * THE FAN-OUT
 * ---------------------------------------------------------------------------
 * A persona with a real audience means one notification row per follower per
 * publish, so this is shaped as a bounded pipeline rather than a loop:
 *
 *  1. ONE indexed query reads the follower ids
 *     (`IDX_subprofile_followers_subprofile_id`), capped at
 *     `UPDATE_NOTIFY_MAX_RECIPIENTS`.
 *  2. Co-owners are dropped: a persona's own people do not need telling what
 *     their persona just published.
 *  3. The rest are chunked and handed to `NotificationsService`, which is
 *     itself batched — one multi-row INSERT per chunk, with the block/mute and
 *     per-category preference filters applied in two more batched queries. No
 *     per-recipient write exists anywhere on this path.
 *  4. The chunks run through `runWithConcurrency`, a SLIDING POOL. Not waves
 *     of `Promise.all`: a wave costs its slowest member and leaves the other
 *     workers idle at the barrier, which is how a previous fix here ended up
 *     slower than the bug it replaced.
 *  5. Push rides the write. Each chunk's `NOTIFICATION_BATCH_CREATED` reaches
 *     `PushNotificationListener`, which sends through
 *     `sendSplitByPreviewPreference` (one call, its two sends sequenced) and
 *     whose own device fan-out is already capped by `PushService.sendToUsers`.
 *
 * And it does not become a storm: `PersonaUpdate` bundles on `subprofileId`
 * (see `notification-bundling.ts`), so an owner filling in a whole section
 * across an afternoon is ONE unread row per follower, floated back to the top
 * with the newest title on it. A follower who wants none of it turns off the
 * `persona_follows` category and keeps every persona they follow.
 */
@Injectable()
export class SubprofileUpdatesService {
  private readonly logger = new Logger(SubprofileUpdatesService.name);

  constructor(
    @InjectRepository(SubprofileItem)
    private readonly items: Repository<SubprofileItem>,
    @InjectRepository(SubprofileFollower)
    private readonly followers: Repository<SubprofileFollower>,
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The section's item titles as they stand BEFORE a `replaceSection` write,
   * in position order. Called by `SubprofilesService` before the transaction,
   * mirroring how it snapshots the collaborator set for
   * `SubprofileCreditsService`: after the write the old rows are gone, so the
   * "did this grow, and by what?" question has to be asked first.
   */
  async snapshotSectionTitles(
    subprofileId: string,
    section: SubprofileSection,
  ): Promise<string[]> {
    const rows = await this.items.find({
      where: { subprofileId, section },
      order: { position: 'ASC' },
      select: { title: true },
    });
    return rows.map((row) => row.title);
  }

  /**
   * Post-commit, best-effort: tell this persona's followers that the section
   * grew. Never throws back at the caller — the section save has already
   * committed, and a bell that did not ring is not worth losing somebody's
   * work over.
   */
  async notifyFollowersOfNewItems(
    persona: Subprofile,
    titlesBefore: string[],
    titlesAfter: string[],
    section: SubprofileSection,
  ): Promise<void> {
    try {
      const newItemCount = this.countNewItems(
        persona,
        titlesBefore,
        titlesAfter,
        section,
      );
      if (newItemCount === 0) return;

      const recipientIds = await this.followerRecipientIds(persona);
      if (!recipientIds.length) return;

      const payload = {
        subprofileName: persona.displayName,
        subprofileSlugOrHandle: persona.handle ?? persona.slug,
        subprofileId: persona.id,
        itemTitle: this.newestNewTitle(titlesBefore, titlesAfter),
        newItemCount,
        deepLink: await this.buildPersonaDeepLink(persona),
      };

      const chunkThunks: Array<() => Promise<string[]>> = [];
      for (
        let offset = 0;
        offset < recipientIds.length;
        offset += UPDATE_NOTIFY_CHUNK_SIZE
      ) {
        const chunk = recipientIds.slice(
          offset,
          offset + UPDATE_NOTIFY_CHUNK_SIZE,
        );
        // A THUNK, never a started promise: an already-started promise has
        // claimed its pool connection before `runWithConcurrency` ever sees
        // it, which silently defeats the cap.
        chunkThunks.push(() =>
          this.notifications.createForRecipients(
            chunk,
            NotificationType.PersonaUpdate,
            payload,
            // The persona OWNER, for the per-recipient block/mute filter only.
            // This id never reaches the payload, and `PersonaUpdate` appears
            // under no key in `ACTOR_PAYLOAD_KEY`, so no follower's bell ever
            // names the human behind a pseudonymous persona.
            persona.userId,
          ),
        );
      }
      await runWithConcurrency(
        chunkThunks,
        UPDATE_NOTIFY_MAX_CONCURRENT_CHUNKS,
      );
    } catch (error) {
      this.logger.warn(
        `Persona update fan-out failed for ${persona.id}: ${String(error)}`,
      );
    }
  }

  /**
   * How many items this save ADDED to the section, or 0 when nothing here is
   * worth telling a follower about. See the class docstring for why growth in
   * count is the test and every other kind of diff is not.
   */
  private countNewItems(
    persona: Subprofile,
    titlesBefore: string[],
    titlesAfter: string[],
    section: SubprofileSection,
  ): number {
    // A persona nobody can open publishes nothing. Same three states the
    // public read path withholds, so a follower is never told about work they
    // would then be unable to see.
    if (
      persona.status !== SubprofileStatus.Published ||
      persona.visibility !== SubprofileVisibility.Open ||
      persona.removedAt
    ) {
      return 0;
    }
    if (section === SubprofileSection.Links) return 0;
    return Math.max(0, titlesAfter.length - titlesBefore.length);
  }

  /**
   * The title the bell names: the first incoming title that was not in the
   * section before.
   */
  private newestNewTitle(
    titlesBefore: string[],
    titlesAfter: string[],
  ): string | null {
    const existingTitles = new Set(titlesBefore);
    const firstUnseenTitle = titlesAfter.find(
      (title) => !existingTitles.has(title),
    );
    if (firstUnseenTitle) return firstUnseenTitle;
    // Every incoming title already existed, which is legal: an item can be
    // added with a title the section already carries. The section still grew,
    // so the LAST item is the best honest guess at what was just appended, and
    // it keeps the bell copy from having to interpolate an empty title.
    return titlesAfter[titlesAfter.length - 1] ?? null;
  }

  /**
   * The persona's followers, minus its own co-owners, bounded. One indexed
   * read for the followers and one for the roster, regardless of audience
   * size.
   */
  private async followerRecipientIds(persona: Subprofile): Promise<string[]> {
    const followerRows = await this.followers.find({
      where: { subprofileId: persona.id },
      select: { followerId: true },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: UPDATE_NOTIFY_MAX_RECIPIENTS,
    });
    if (!followerRows.length) return [];
    const followerIds = followerRows.map((row) => row.followerId);

    const rosterRows = await this.members.find({
      where: { subprofileId: persona.id, userId: In(followerIds) },
      select: { userId: true },
    });
    const coOwnerIds = new Set(rosterRows.map((row) => row.userId));
    return followerIds.filter((followerId) => !coOwnerIds.has(followerId));
  }

  /**
   * The persona's own page, for the notification's deep link. Same two shapes
   * and the same anonymity rule `SubprofileCreditsService.buildPersonaDeepLink`
   * applies: an UNLINKED persona resolves to its standalone `/p/:handle` page
   * and never to its owner's, a LINKED one to `/members/:ownerSlug/:slug`.
   */
  private async buildPersonaDeepLink(persona: Subprofile): Promise<string> {
    if (
      persona.linkVisibility === SubprofileLinkVisibility.Unlinked &&
      persona.handle
    ) {
      return `/p/${persona.handle}`;
    }
    const ownerProfile = await this.profiles.findOne({
      where: { userId: persona.userId },
    });
    return ownerProfile
      ? `/members/${ownerProfile.slug}/${persona.slug}`
      : `/subprofiles`;
  }
}

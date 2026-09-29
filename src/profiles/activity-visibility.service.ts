import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Raw, Repository } from 'typeorm';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { TOP_LEVEL_WHERE } from '../communities/subcommunity-rules';
import {
  Connection,
  ConnectionStatus,
} from '../connections/entities/connection.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { forumThreadVisibleSql } from '../forum/forum-threads.service';
import {
  Event as GatheringEvent,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import {
  EventRsvp,
  RsvpDetailsVisibility,
  RsvpStatus,
} from '../events/entities/event-rsvp.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from '../subprofiles/subprofile-takedown';
import { Activity, ActivitySubjectKind } from './entities/activity.entity';

/**
 * The READ half of the profile activity privacy gate.
 *
 * `ActivityListener` gates at the write: a row is only ever created for an
 * action whose subject was public at that instant. That gate is necessary and
 * insufficient, because a subject's visibility can change AFTERWARDS:
 *
 *  - a `public` event is switched to members-only or invite-only, or
 *    cancelled, or unpublished back to a draft,
 *  - a `public` community is switched to request/invite/private, or archived,
 *  - a published persona is unpublished, made network/private, or taken down
 *    by a moderator,
 *  - a forum thread is withdrawn, rescheduled, sent back to review, or its
 *    community turns private; or the row was written for an anonymous or
 *    official thread before the write gate kept those out.
 *
 * In every one of those cases the stored row keeps asserting a fact that has
 * stopped being public, and the deep link now points somewhere the viewer may
 * not be allowed to go. So the row is re-checked against its subject on every
 * read, and a row whose subject is no longer public is DROPPED whole:
 * "attended X" is itself the disclosure, the link is only the second half of
 * it.
 *
 * Dropping is paired with a best-effort PURGE of the row. The purge exists
 * because this service is not the only reader of the `activities` table:
 * `PublicProfilesService` serves the same rows to the anonymous web without a
 * gate of its own. Deleting the offending row here means the next public read
 * cannot serve it either, so one signed-in view of the profile heals the row
 * for every audience. The purge is fire-and-forget and never blocks or fails
 * the read.
 *
 * An Event row carries a SECOND, independent gate on top of the subject
 * re-check: PRD-414's "who can see you're going" (`event_rsvps.visibility`,
 * see `attendee-roster-visibility.ts`). A gathering staying public says
 * nothing about whether ITS ATTENDEE still wants their own "RSVP'd to X" row
 * shown, so a row that survives the public-event check above is re-checked
 * again against that attendee's own setting. A row hidden by this second gate
 * is left in place with the purge skipped, because the attendee can switch
 * the setting back at any time and the hidden row would still be true the
 * moment they do.
 *
 * Rows with a null `subjectKind` were written before the subject columns
 * existed. They pass through untouched, which is exactly their previous
 * behaviour. Forum thread rows from that era carry a thread link, and
 * `1823800200000-BackfillForumThreadActivitySubjects` gives them their
 * `forum_thread` subject so this gate re-checks them too.
 */
@Injectable()
export class ActivityVisibilityService {
  private readonly logger = new Logger(ActivityVisibilityService.name);

  constructor(
    @InjectRepository(Activity)
    private readonly activities: Repository<Activity>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(GatheringEvent)
    private readonly events: Repository<GatheringEvent>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
  ) {}

  /**
   * `rows` narrowed to those whose subject is still public, order preserved.
   *
   * At most four batched lookups, one per subject kind present, each an
   * `IN (...)` over the ids this page of rows actually references. Callers
   * over-fetch (see `ProfilesService`) so that dropping a few still leaves a
   * full page.
   *
   * `viewerId` is who is reading, or `null` for an anonymous caller
   * (`PublicProfilesService`'s public profile page), who is treated as a
   * stranger to every attendee. It backs the Event arm's second gate: see
   * `filterByRsvpVisibility`.
   */
  async filterVisible(
    rows: Activity[],
    viewerId: string | null = null,
  ): Promise<Activity[]> {
    if (!rows.length) {
      return rows;
    }
    const idsByKind = new Map<ActivitySubjectKind, Set<string>>();
    for (const row of rows) {
      if (!row.subjectKind || !row.subjectId) {
        continue;
      }
      const bucket = idsByKind.get(row.subjectKind) ?? new Set<string>();
      bucket.add(row.subjectId);
      idsByKind.set(row.subjectKind, bucket);
    }
    if (!idsByKind.size) {
      return rows;
    }
    const [
      publicEventSlugs,
      publicCommunitySlugs,
      publicPersonaIds,
      publicForumThreadSlugs,
    ] = await Promise.all([
      this.publicEventSlugs([
        ...(idsByKind.get(ActivitySubjectKind.Event) ?? []),
      ]),
      this.publicCommunitySlugs([
        ...(idsByKind.get(ActivitySubjectKind.Community) ?? []),
      ]),
      this.publicPersonaIds([
        ...(idsByKind.get(ActivitySubjectKind.Persona) ?? []),
      ]),
      this.publicForumThreadSlugs([
        ...(idsByKind.get(ActivitySubjectKind.ForumThread) ?? []),
      ]),
    ]);
    const stillPublicByKind: Record<ActivitySubjectKind, Set<string>> = {
      [ActivitySubjectKind.Event]: publicEventSlugs,
      [ActivitySubjectKind.Community]: publicCommunitySlugs,
      [ActivitySubjectKind.Persona]: publicPersonaIds,
      [ActivitySubjectKind.ForumThread]: publicForumThreadSlugs,
    };
    const visible: Activity[] = [];
    const staleRowIds: string[] = [];
    for (const row of rows) {
      if (!row.subjectKind || !row.subjectId) {
        visible.push(row);
        continue;
      }
      if (stillPublicByKind[row.subjectKind].has(row.subjectId)) {
        visible.push(row);
      } else {
        staleRowIds.push(row.id);
      }
    }
    if (staleRowIds.length) {
      void this.purge(staleRowIds);
    }
    return this.filterByRsvpVisibility(visible, viewerId);
  }

  /**
   * Of `slugs`, the events that are still public: published (a draft or a
   * cancelled gathering is not a public fact either) and `public`-visibility.
   * A slug that has vanished entirely is simply absent, so a deleted event's
   * row is dropped for free.
   */
  private async publicEventSlugs(slugs: string[]): Promise<Set<string>> {
    if (!slugs.length) {
      return new Set();
    }
    const rows = await this.events.find({
      where: {
        slug: In(slugs),
        status: EventStatus.Published,
        visibility: EventVisibility.Public,
      },
      select: { slug: true },
    });
    return new Set(rows.map((row) => row.slug));
  }

  /**
   * `rows` (already narrowed to Event-subject rows whose gathering is still
   * public) narrowed again by PRD-414's "who can see you're going"
   * (`event_rsvps.visibility`), order preserved. Everything not passed in as
   * an Event row is returned untouched.
   *
   * The attendee always sees their own row, so rows the viewer themselves
   * owns are skipped for free before any lookup runs. For the rest: one
   * batched `events.find` to turn the page's event slugs into the ids
   * `event_rsvps` actually keys attendance by, one batched `event_rsvps.find`
   * for every (eventId, userId) pair those rows name, plus, only when a
   * viewer is given and at least one surviving RSVP chose `connections`, one
   * batched accepted-connection check between that viewer and those
   * attendees. That last check is the same both-directions, accepted-only
   * test `attendee-roster-visibility.ts` applies inside a roster query, run
   * here on its own once the page is already loaded.
   *
   * A row shows when the viewer is its owner, the RSVP's setting is `null`
   * or `everyone`, or it is `connections` and the viewer is an accepted
   * connection of the owner. A row with no live RSVP behind it (the RSVP
   * row is gone, or its status is `cancelled`, so the roster no longer lists
   * the attendee either way) shows to its owner alone, like the roster. A
   * `justMe` row shows to the owner alone; the
   * gathering's organisers get their full roster from the roster read, and
   * this gate treats them like any other viewer. Hidden rows drop from the
   * result and stay off the purge queue entirely; see the class doc for why.
   */
  private async filterByRsvpVisibility(
    rows: Activity[],
    viewerId: string | null,
  ): Promise<Activity[]> {
    const eventRows = rows.filter(
      (row) => row.subjectKind === ActivitySubjectKind.Event,
    );
    if (!eventRows.length) {
      return rows;
    }
    const lookupRows = eventRows.filter((row) => row.userId !== viewerId);
    if (!lookupRows.length) {
      return rows;
    }
    const slugs = [
      ...new Set(lookupRows.map((row) => row.subjectId as string)),
    ];
    const ownerIds = [...new Set(lookupRows.map((row) => row.userId))];
    const events = await this.events.find({
      where: { slug: In(slugs) },
      select: { id: true, slug: true },
    });
    const eventIdBySlug = new Map(
      events.map((event) => [event.slug, event.id]),
    );
    const eventIds = [...eventIdBySlug.values()];
    const rsvps = eventIds.length
      ? await this.activities.manager.getRepository(EventRsvp).find({
          where: { eventId: In(eventIds), userId: In(ownerIds) },
          select: {
            eventId: true,
            userId: true,
            visibility: true,
            status: true,
          },
        })
      : [];
    const visibilityByKey = new Map<string, RsvpDetailsVisibility | null>();
    for (const rsvp of rsvps) {
      // A cancelled RSVP is left in place by both `rsvp.service.ts`'s
      // self-cancel and host-removal paths, so this map skips it exactly
      // like an RSVP that was deleted outright: the roster already drops a
      // cancelled attendee, and this gate keeps that row in step with it.
      if (rsvp.status === RsvpStatus.Cancelled) {
        continue;
      }
      visibilityByKey.set(`${rsvp.eventId}:${rsvp.userId}`, rsvp.visibility);
    }
    // `undefined` when no live RSVP row backs the activity: the row is
    // hidden from everyone but its owner by the loop below.
    const visibilityOf = (
      row: Activity,
    ): RsvpDetailsVisibility | null | undefined => {
      const eventId = eventIdBySlug.get(row.subjectId as string);
      if (!eventId) {
        return undefined;
      }
      return visibilityByKey.get(`${eventId}:${row.userId}`);
    };
    const connectionsOwnerIds = new Set(
      lookupRows
        .filter((row) => visibilityOf(row) === 'connections')
        .map((row) => row.userId),
    );
    const connectedOwnerIds =
      viewerId && connectionsOwnerIds.size
        ? await this.connectedOwnerIds(viewerId, [...connectionsOwnerIds])
        : new Set<string>();
    const hiddenRowIds = new Set<string>();
    for (const row of lookupRows) {
      const visibility = visibilityOf(row);
      if (visibility === null || visibility === 'everyone') {
        continue;
      }
      if (visibility === 'connections' && connectedOwnerIds.has(row.userId)) {
        continue;
      }
      hiddenRowIds.add(row.id);
    }
    if (!hiddenRowIds.size) {
      return rows;
    }
    return rows.filter((row) => !hiddenRowIds.has(row.id));
  }

  /**
   * Of `ownerIds`, those accepted-connected to `viewerId`: the same
   * both-directions, `status = accepted` test `attendee-roster-visibility.ts`
   * splices into a roster query, as one bounded `IN (...)` lookup.
   */
  private async connectedOwnerIds(
    viewerId: string,
    ownerIds: string[],
  ): Promise<Set<string>> {
    const connected = new Set<string>();
    if (!ownerIds.length) {
      return connected;
    }
    const edges = await this.activities.manager.getRepository(Connection).find({
      where: [
        {
          requesterId: viewerId,
          addresseeId: In(ownerIds),
          status: ConnectionStatus.Accepted,
        },
        {
          addresseeId: viewerId,
          requesterId: In(ownerIds),
          status: ConnectionStatus.Accepted,
        },
      ],
    });
    for (const edge of edges) {
      connected.add(
        edge.requesterId === viewerId ? edge.addresseeId : edge.requesterId,
      );
    }
    return connected;
  }

  /** Of `slugs`, the communities that are still top-level, public-tier and
   *  unarchived. A row recorded for a space before this gate existed drops
   *  out here at read time: "Posted in X" must never re-surface a space's
   *  name once the read half re-checks it. */
  private async publicCommunitySlugs(slugs: string[]): Promise<Set<string>> {
    if (!slugs.length) {
      return new Set();
    }
    const rows = await this.communities.find({
      where: {
        slug: In(slugs),
        accessTier: AccessTier.Public,
        archivedAt: IsNull(),
        ...TOP_LEVEL_WHERE,
      },
      select: { slug: true },
    });
    return new Set(rows.map((row) => row.slug));
  }

  /**
   * Of `ids`, the personas that are still public: published, `open`
   * visibility, Linked, and not withheld by a moderator takedown, whether
   * that is the persona's own `removedAt` or a `content_moderation` hide or
   * remove action against it (the same rule `excludeModeratedSubprofiles` in
   * `SubprofilePublicReadService` applies). A network- or private-visibility
   * persona is excluded even though it is "published": the activity row is
   * served to audiences as wide as the open web, so `open` is the only
   * visibility safe for it. Linked
   * mirrors `ActivityListener`'s own write gate: the row names its author, and
   * an Unlinked persona is deliberately unattributed, so a persona switched to
   * Unlinked (and republished at its handle, possibly by a successor after a
   * creator handoff) must not stay tied to the member who wrote the row.
   */
  private async publicPersonaIds(ids: string[]): Promise<Set<string>> {
    if (!ids.length) {
      return new Set();
    }
    const rows = await this.subprofiles.find({
      where: {
        // `CAST(... AS text)` over `::text`: TypeORM quotes the `Subprofile.id`
        // path it hands in only when a space, `=`, `)` or `,` follows it, and
        // the bare mixed-case alias fails in Postgres.
        id: Raw(
          (idColumn) =>
            `${idColumn} IN (:...personaIds) AND NOT EXISTS (
              SELECT 1 FROM "content_moderation" "cm"
              WHERE "cm"."subject_type" = :subprofileTakedownSubjectType
                AND "cm"."subject_id" = CAST(${idColumn} AS text)
                AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
            )`,
          {
            personaIds: ids,
            subprofileTakedownSubjectType: SUBPROFILE_MODERATION_SUBJECT_TYPE,
          },
        ),
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
        linkVisibility: SubprofileLinkVisibility.Linked,
        removedAt: IsNull(),
      },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Of `slugs`, the forum threads that are still a public fact about their
   * writer: not deleted, published and through review (the forum's own
   * `forumThreadVisibleSql` gate), under the writer's own byline (neither
   * anonymous nor official), and readable forum-wide. Forum-wide means no
   * community, cross-posted, or a public, top-level, unarchived community,
   * the same three arms `ForumThreadsService` gates its fan-out on.
   */
  private async publicForumThreadSlugs(slugs: string[]): Promise<Set<string>> {
    if (!slugs.length) {
      return new Set();
    }
    const rows = await this.activities.manager
      .createQueryBuilder(ForumThread, 't')
      .select('t.slug', 'slug')
      .where('t.slug IN (:...slugs)', { slugs })
      .andWhere('t.deleted_at IS NULL')
      .andWhere(forumThreadVisibleSql('t'))
      .andWhere('t.is_anonymous = false')
      .andWhere('t.is_official = false')
      .andWhere(
        `(
          t.community_id IS NULL
          OR t.cross_posted = true
          OR EXISTS (
            SELECT 1 FROM "communities" "activity_com"
            WHERE "activity_com"."id" = t.community_id
              AND "activity_com"."access_tier" = :activityPublicTier
              AND "activity_com"."parent_id" IS NULL
              AND "activity_com"."archived_at" IS NULL
          )
        )`,
        { activityPublicTier: AccessTier.Public },
      )
      .getRawMany<{ slug: string }>();
    return new Set(rows.map((row) => row.slug));
  }

  /**
   * Delete rows whose subject stopped being public. Best-effort and detached
   * from the read: a failure here leaves the row in place for the next reader
   * to try again, and never turns a profile read into an error.
   */
  private async purge(rowIds: string[]): Promise<void> {
    try {
      await this.activities.delete({ id: In(rowIds) });
    } catch (error) {
      this.logger.warn(
        `Failed to purge ${rowIds.length} stale activity row(s): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

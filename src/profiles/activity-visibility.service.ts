import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import {
  Event as GatheringEvent,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
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
 *    by a moderator.
 *
 * In every one of those cases the stored row keeps asserting a fact that has
 * stopped being public, and the deep link now points somewhere the viewer may
 * not be allowed to go. So the row is re-checked against its subject on every
 * read, and a row whose subject is no longer public is DROPPED, never merely
 * unlinked: "attended X" is itself the disclosure, the link is only the second
 * half of it.
 *
 * Dropping is paired with a best-effort PURGE of the row. The purge exists
 * because this service is not the only reader of the `activities` table:
 * `PublicProfilesService` serves the same rows to the anonymous web without a
 * gate of its own. Deleting the offending row here means the next public read
 * cannot serve it either, so one signed-in view of the profile heals the row
 * for every audience. The purge is fire-and-forget and never blocks or fails
 * the read.
 *
 * Rows with a null `subjectKind` are UNVERIFIABLE, not suspect: they are forum
 * threads (no visibility dimension, see `ForumThreadCreatedEvent`) and rows
 * written before the subject columns existed. They pass through untouched,
 * which for the legacy rows is exactly their previous behaviour.
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
   * At most three batched lookups, one per subject kind present, each an
   * `IN (...)` over the ids this page of rows actually references. Callers
   * over-fetch (see `ProfilesService`) so that dropping a few still leaves a
   * full page.
   */
  async filterVisible(rows: Activity[]): Promise<Activity[]> {
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
    const [publicEventSlugs, publicCommunitySlugs, publicPersonaIds] =
      await Promise.all([
        this.publicEventSlugs([
          ...(idsByKind.get(ActivitySubjectKind.Event) ?? []),
        ]),
        this.publicCommunitySlugs([
          ...(idsByKind.get(ActivitySubjectKind.Community) ?? []),
        ]),
        this.publicPersonaIds([
          ...(idsByKind.get(ActivitySubjectKind.Persona) ?? []),
        ]),
      ]);
    const stillPublicByKind: Record<ActivitySubjectKind, Set<string>> = {
      [ActivitySubjectKind.Event]: publicEventSlugs,
      [ActivitySubjectKind.Community]: publicCommunitySlugs,
      [ActivitySubjectKind.Persona]: publicPersonaIds,
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
    return visible;
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

  /** Of `slugs`, the communities that are still public-tier and unarchived. */
  private async publicCommunitySlugs(slugs: string[]): Promise<Set<string>> {
    if (!slugs.length) {
      return new Set();
    }
    const rows = await this.communities.find({
      where: {
        slug: In(slugs),
        accessTier: AccessTier.Public,
        archivedAt: IsNull(),
      },
      select: { slug: true },
    });
    return new Set(rows.map((row) => row.slug));
  }

  /**
   * Of `ids`, the personas that are still public: published, `open`
   * visibility, and not withheld by a moderator takedown (`removedAt`). A
   * network- or private-visibility persona is excluded even though it is
   * "published": the activity row is served to audiences as wide as the open
   * web, so `open` is the only visibility safe for it.
   */
  private async publicPersonaIds(ids: string[]): Promise<Set<string>> {
    if (!ids.length) {
      return new Set();
    }
    const rows = await this.subprofiles.find({
      where: {
        id: In(ids),
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
        removedAt: IsNull(),
      },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
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

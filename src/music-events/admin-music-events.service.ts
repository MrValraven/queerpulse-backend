import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { normalizePage, PAGE_SIZE } from '../common/pagination';
import { EventVisibility } from '../events/entities/event.entity';
import type { GuestPreviewRole } from '../events/event-preview';
import type {
  CreatedEventDetail,
  EventDetail,
  EventSummary,
  UpdatedEventDetail,
} from '../events/event-response';
import { UPCOMING_OR_UNDERWAY_SQL } from '../events/event-schedule-sql';
import { EventsService, type SeriesScope } from '../events/events.service';
import { GatheringFamily } from '../events/gathering-family';
import { houseMusicEventError } from '../events/house-music-event-errors';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import type {
  AdminMusicEventAttention,
  AdminMusicEventLineupCounts,
  AdminMusicEventListItem,
  AdminMusicEventListPage,
} from './admin-music-events-response';
import type { CreateMusicEventDto } from './dto/create-music-event.dto';
import type { ListMusicEventsQuery } from './dto/list-music-events.query';
import type { UpdateMusicEventDto } from './dto/update-music-event.dto';
import { HouseMusicEventScopeService } from './house-music-event-scope.service';
import {
  MUSIC_EVENT_AUDIT_ACTIONS,
  writeMusicEventAudit,
} from './music-event-audit';

/** Event ids for the slugs on one list page. Slugs are unique. */
export const MUSIC_EVENT_IDS_BY_SLUG_SQL = `SELECT "id", "slug" FROM "events" WHERE "slug" = ANY($1::text[])`;

/** Lineup entries per listed event, split by answer state. */
export const MUSIC_EVENT_LINEUP_COUNTS_SQL = `SELECT "event_id", "status"::text AS "status", count(*)::int AS "total" FROM "event_lineup_entries" WHERE "event_id" = ANY($1::uuid[]) GROUP BY 1, 2`;

/** Invite requests still waiting on the host, per listed event. */
export const MUSIC_EVENT_PENDING_REQUEST_COUNTS_SQL = `SELECT "event_id", count(*)::int AS "total" FROM "event_invites" WHERE "event_id" = ANY($1::uuid[]) AND "status"::text = 'awaiting_host' GROUP BY 1`;

/**
 * The page's pending badge: open invite requests and unanswered lineup
 * invites across every non-cancelled Music event the house hosts that is
 * upcoming or underway, whatever bucket the list shows. The schedule
 * predicate is the shared one, bound to `$3` here.
 */
export const MUSIC_EVENT_ATTENTION_SQL = `WITH "attention_events" AS (
  SELECT "e"."id" FROM "events" "e"
  WHERE "e"."host_id" = $1::uuid
    AND "e"."gathering_family"::text = $2::text
    AND "e"."status"::text <> 'cancelled'
    AND ${UPCOMING_OR_UNDERWAY_SQL.replaceAll(':now', '$3::timestamptz')}
)
SELECT
  (SELECT count(*)::int FROM "event_invites" "invite"
    WHERE "invite"."status"::text = 'awaiting_host'
      AND "invite"."event_id" IN (SELECT "id" FROM "attention_events")) AS "pending_invite_request_count",
  (SELECT count(*)::int FROM "event_lineup_entries" "entry"
    WHERE "entry"."status"::text = 'pending'
      AND "entry"."event_id" IN (SELECT "id" FROM "attention_events")) AS "pending_lineup_count"`;

interface EventIdRow {
  id: string;
  slug: string;
}

interface LineupCountRow {
  event_id: string;
  status: string;
  total: number;
}

interface PendingRequestCountRow {
  event_id: string;
  total: number;
}

interface AttentionRow {
  pending_invite_request_count: number;
  pending_lineup_count: number;
}

function emptyLineupCounts(): AdminMusicEventLineupCounts {
  return { pending: 0, accepted: 0, declined: 0 };
}

function isLineupCountKey(
  status: string,
): status is keyof AdminMusicEventLineupCounts {
  return status === 'pending' || status === 'accepted' || status === 'declined';
}

/**
 * The house Music event list, create, read, edit and cancel for staff
 * (contract routes 2 to 6). Every write runs as the house account through
 * `EventsService`, so the member rules apply unchanged, and each one leaves an
 * audit row naming the staff member. The staff member's own event draft is
 * never touched.
 */
@Injectable()
export class AdminMusicEventsService {
  constructor(
    private readonly eventsService: EventsService,
    private readonly houseScope: HouseMusicEventScopeService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ModAuditLog)
    private readonly auditLogs: Repository<ModAuditLog>,
  ) {}

  async list(query: ListMusicEventsQuery): Promise<AdminMusicEventListPage> {
    const houseUserId = await this.houseScope.houseUserId();
    const currentPage = normalizePage(query.page);
    const [hostedPage, attention] = await Promise.all([
      this.eventsService.listHostedInFamily(
        houseUserId,
        GatheringFamily.Music,
        query.bucket ?? 'upcoming',
        currentPage,
      ),
      this.attentionFor(houseUserId),
    ]);
    const items = await this.withCounts(hostedPage.items);
    return {
      items,
      page: currentPage,
      pageSize: PAGE_SIZE,
      hasMore: hostedPage.hasMore,
      attention,
    };
  }

  async create(
    staffUserId: string,
    dto: CreateMusicEventDto,
  ): Promise<CreatedEventDetail> {
    if (
      dto.gatheringFamily !== undefined &&
      dto.gatheringFamily !== GatheringFamily.Music
    ) {
      throw houseMusicEventError('house_event_family_locked');
    }
    this.assertNotCommunityOnly(dto.visibility);
    const houseUserId = await this.houseScope.houseUserId();
    const created = await this.eventsService.create(houseUserId, {
      ...dto,
      gatheringFamily: GatheringFamily.Music,
    });
    const dateCount = created.occurrenceSlugs.length;
    await writeMusicEventAudit(this.auditLogs, {
      actorId: staffUserId,
      action: MUSIC_EVENT_AUDIT_ACTIONS.created,
      eventSlug: created.slug,
      eventTitle: created.title,
      detail: dateCount > 1 ? `${dateCount} dates` : undefined,
    });
    return created;
  }

  async read(slug: string, viewAs?: GuestPreviewRole): Promise<EventDetail> {
    const { houseUserId } = await this.houseScope.loadOrNotFound(slug);
    return this.eventsService.getBySlug(slug, houseUserId, viewAs);
  }

  async update(
    staffUserId: string,
    slug: string,
    dto: UpdateMusicEventDto,
    scope: SeriesScope,
  ): Promise<UpdatedEventDetail> {
    const { houseUserId } = await this.houseScope.loadOrNotFound(slug);
    this.assertNotCommunityOnly(dto.visibility);
    const updated = await this.eventsService.update(
      slug,
      houseUserId,
      dto,
      scope,
      { uploaderUserId: staffUserId },
    );
    await writeMusicEventAudit(this.auditLogs, {
      actorId: staffUserId,
      action: MUSIC_EVENT_AUDIT_ACTIONS.updated,
      eventSlug: updated.slug,
      eventTitle: updated.title,
      detail: `scope ${scope}`,
    });
    return updated;
  }

  async cancel(
    staffUserId: string,
    slug: string,
    scope: SeriesScope,
  ): Promise<EventDetail> {
    const { houseUserId } = await this.houseScope.loadOrNotFound(slug);
    const cancelled = await this.eventsService.cancel(slug, houseUserId, scope);
    await writeMusicEventAudit(this.auditLogs, {
      actorId: staffUserId,
      action: MUSIC_EVENT_AUDIT_ACTIONS.cancelled,
      eventSlug: cancelled.slug,
      eventTitle: cancelled.title,
      detail: `scope ${scope}`,
    });
    return cancelled;
  }

  /** A house Music event is open to members at large, so it never takes the
   *  community-only audience. */
  private assertNotCommunityOnly(
    visibility: EventVisibility | undefined,
  ): void {
    if (visibility === EventVisibility.Community) {
      throw houseMusicEventError('music_event_community_unavailable');
    }
  }

  private async withCounts(
    summaries: EventSummary[],
  ): Promise<AdminMusicEventListItem[]> {
    if (summaries.length === 0) return [];
    const idRows = await this.dataSource.query<EventIdRow[]>(
      MUSIC_EVENT_IDS_BY_SLUG_SQL,
      [summaries.map((summary) => summary.slug)],
    );
    const idBySlug = new Map(idRows.map((row) => [row.slug, row.id]));
    const eventIds = [...idBySlug.values()];
    const [lineupRows, requestRows] = await Promise.all([
      this.dataSource.query<LineupCountRow[]>(MUSIC_EVENT_LINEUP_COUNTS_SQL, [
        eventIds,
      ]),
      this.dataSource.query<PendingRequestCountRow[]>(
        MUSIC_EVENT_PENDING_REQUEST_COUNTS_SQL,
        [eventIds],
      ),
    ]);
    const lineupCountsByEventId = new Map<
      string,
      AdminMusicEventLineupCounts
    >();
    for (const row of lineupRows) {
      if (!isLineupCountKey(row.status)) continue;
      const counts =
        lineupCountsByEventId.get(row.event_id) ?? emptyLineupCounts();
      counts[row.status] = row.total;
      lineupCountsByEventId.set(row.event_id, counts);
    }
    const requestCountByEventId = new Map(
      requestRows.map((row) => [row.event_id, row.total]),
    );
    return summaries.map((summary) => {
      const eventId = idBySlug.get(summary.slug) ?? '';
      return {
        ...summary,
        lineupCounts: lineupCountsByEventId.get(eventId) ?? emptyLineupCounts(),
        pendingInviteRequestCount: requestCountByEventId.get(eventId) ?? 0,
      };
    });
  }

  private async attentionFor(
    houseUserId: string,
  ): Promise<AdminMusicEventAttention> {
    const rows = await this.dataSource.query<AttentionRow[]>(
      MUSIC_EVENT_ATTENTION_SQL,
      [houseUserId, GatheringFamily.Music, new Date()],
    );
    const [row] = rows;
    return {
      pendingInviteRequestCount: row?.pending_invite_request_count ?? 0,
      pendingLineupCount: row?.pending_lineup_count ?? 0,
    };
  }
}

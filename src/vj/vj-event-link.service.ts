import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { isPlatformStaffTier } from '../auth/platform-staff-tier';
import { Event } from '../events/entities/event.entity';
import { gatheringPath } from '../events/event-paths';
import type { SetVjPackEventDto } from './dto/vj.dto';
import { VjPack } from './entities/vj-pack.entity';
import { readEventIdBody } from './vj-input';
import {
  asVjDate,
  buildVjLibraryChange,
  lowercaseIdOrRefuse,
  runVjTransaction,
} from './vj-library-kit';
import { readVjPackDto } from './vj-library-reads';
import {
  isVjEventListed,
  toVjEventCard,
  toVjEventOption,
  vjEventCardUnavailableReason,
  type VjEventOptionListDTO,
  type VjEventRow,
  type VjPackClipsDTO,
  type VjPackDTO,
  type VjPackEventDTO,
  type VjPackListDTO,
} from './vj-response';
import { vjError } from './vj.constants';
import { VJ_LIBRARY_CHANGED } from './vj.contract';

/** The `events` columns VJ reads, in `VjEventRow` order: the card and the
 *  upcoming list select exactly these, and nothing that names a host, an
 *  attendee, a persona or the address. */
export const VJ_EVENT_CARD_COLUMNS = [
  'id',
  'title',
  'slug',
  'start_at',
  'end_at',
  'timezone',
  'neighbourhood',
  'is_online',
  'status',
  'visibility',
] as const;

/** The published public and members events a pack may link to: starting no
 *  more than 12 hours ago and not yet over (an unset end counts as six hours
 *  after the start), soonest first, at most 50. Backed by
 *  `IDX_events_status_start_at`. */
export const VJ_UPCOMING_EVENTS_SQL = `SELECT "event"."id", "event"."title", "event"."slug", "event"."start_at", "event"."end_at", "event"."timezone", "event"."neighbourhood", "event"."is_online", "event"."status", "event"."visibility"
FROM "events" "event"
WHERE "event"."status" = 'published' AND "event"."visibility" IN ('public', 'members') AND "event"."start_at" >= now() - interval '12 hours' AND COALESCE("event"."end_at", "event"."start_at" + interval '6 hours') >= now()
ORDER BY "event"."start_at" ASC, "event"."id" ASC
LIMIT 50`;

/** `$1` one pack id. One row when the pack exists, with the linked event's
 *  card columns prefixed `event_` (all null with no link). Selects nothing
 *  else of the event. */
export const VJ_PACK_EVENT_CARD_SQL = `SELECT "pack"."id" AS "pack_id", "event"."id" AS "event_id", "event"."title" AS "event_title", "event"."slug" AS "event_slug", "event"."start_at" AS "event_start_at", "event"."end_at" AS "event_end_at", "event"."timezone" AS "event_timezone", "event"."neighbourhood" AS "event_neighbourhood", "event"."is_online" AS "event_is_online", "event"."status" AS "event_status", "event"."visibility" AS "event_visibility"
FROM "vj_packs" "pack"
LEFT JOIN "events" "event" ON "event"."id" = "pack"."event_id"
WHERE "pack"."id" = $1::uuid`;

/** `$1` event ids. The ids among them that a member's event listings leave
 *  out although their status and visibility would list them: an event
 *  moderation hid or removed (the rule of `EventsService
 *  .excludeModeratedEvents`), and an event hosted by a space (spaces never
 *  appear in Discover, `EventAudienceGateService.scopedVisibilityWhere`).
 *  Selects the id alone. Read only for a caller outside the platform staff
 *  tiers, so a VJ operator never reaches an event a plain member could not
 *  find. */
export const VJ_MEMBER_WITHHELD_EVENT_IDS_SQL = `SELECT "event"."id"
FROM "events" "event"
WHERE "event"."id" = ANY($1::uuid[]) AND (EXISTS (SELECT 1 FROM "content_moderation" "moderation" WHERE "moderation"."subject_type" = 'event' AND "moderation"."subject_id" = "event"."id"::text AND ("moderation"."hidden_at" IS NOT NULL OR "moderation"."removed_at" IS NOT NULL)) OR EXISTS (SELECT 1 FROM "communities" "host_community" WHERE "host_community"."id" = "event"."community_id" AND "host_community"."parent_id" IS NOT NULL))`;

/** Who is reading an event card, list or pack: the account tier decides how
 *  much of an event the answer carries. */
export type VjEventViewer = Pick<CurrentUserData, 'role'>;

/** The pack event link takes this before the pack row, so its row update
 *  waits behind a pack rename, reorder or delete holding
 *  `LOCK_VJ_PACKS_SQL`, and never holds the pack row while it waits on that
 *  table lock. Row exclusive lets two link writes run at once. */
export const LOCK_VJ_PACKS_ROW_EXCLUSIVE_SQL =
  'LOCK TABLE "vj_packs" IN ROW EXCLUSIVE MODE';

/** A pack's event link that names an event deleted between the read and
 *  the write answers the missing event. */
const PACK_EVENT_LINK_REFUSALS = {
  onForeignKey: new Map([
    ['FK_vj_packs_event', () => vjError('VJ_EVENT_NOT_FOUND')],
  ]),
};

/** One event row as the driver hands back the card columns. */
interface VjEventRawRow {
  id: string;
  title: string;
  slug: string;
  start_at: Date | string;
  end_at: Date | string | null;
  timezone: string;
  neighbourhood: string | null;
  is_online: boolean;
  status: string;
  visibility: string;
}

/** One row of `VJ_PACK_EVENT_CARD_SQL`. */
interface VjPackEventCardRawRow {
  pack_id: string;
  event_id: string | null;
  event_title: string | null;
  event_slug: string | null;
  event_start_at: Date | string | null;
  event_end_at: Date | string | null;
  event_timezone: string | null;
  event_neighbourhood: string | null;
  event_is_online: boolean | null;
  event_status: string | null;
  event_visibility: string | null;
}

/** A raw event row as the structural row the mappers read. */
function toVjEventRow(raw: VjEventRawRow): VjEventRow {
  return {
    id: raw.id,
    title: raw.title,
    slug: raw.slug,
    startAt: asVjDate(raw.start_at),
    endAt: raw.end_at === null ? null : asVjDate(raw.end_at),
    timezone: raw.timezone,
    neighbourhood: raw.neighbourhood,
    isOnline: raw.is_online,
    status: raw.status,
    visibility: raw.visibility,
  };
}

/** The linked event of a card row, or null when the pack links none. */
function toLinkedEventRow(raw: VjPackEventCardRawRow): VjEventRow | null {
  if (raw.event_id === null) {
    return null;
  }
  return toVjEventRow({
    id: raw.event_id,
    title: raw.event_title ?? '',
    slug: raw.event_slug ?? '',
    start_at: raw.event_start_at ?? new Date(0),
    end_at: raw.event_end_at,
    timezone: raw.event_timezone ?? '',
    neighbourhood: raw.event_neighbourhood,
    is_online: raw.event_is_online === true,
    status: raw.event_status ?? '',
    visibility: raw.event_visibility ?? '',
  });
}

/**
 * A pack's event link, the projector's event card and the upcoming events
 * the link picker lists (contract 6.2). Every read selects only the
 * `VjEventRow` columns of `events`: nothing touches hosts, co-hosts, RSVPs,
 * personas or the address, and only a published public or members event
 * reaches a card. The link write emits `VJ_LIBRARY_CHANGED` after commit.
 * Nothing here logs: an event title, slug or URL never reaches a log line or
 * a refusal message.
 *
 * Admins and moderators read every listed event. A caller outside the
 * platform staff tiers (a holder of the `vj_operator` grant) reads only what
 * a plain member could find in the event listings
 * (`VJ_MEMBER_WITHHELD_EVENT_IDS_SQL`): the upcoming list leaves the rest out,
 * the card answers `not_listed`, the link answers `VJ_EVENT_NOT_LINKABLE`, and
 * a pack linked to an event members can no longer see arrives with the event
 * id and `isAvailable: false` only (`packsAsSeenBy`).
 */
@Injectable()
export class VjEventLinkService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** The pack's event card, or the reason the card may not show the linked
   *  event. A pack with no link answers a null card and a null reason. */
  async getPackEvent(
    requestedPackId: string,
    viewer: VjEventViewer,
  ): Promise<VjPackEventDTO> {
    const packId = lowercaseIdOrRefuse(requestedPackId, 'VJ_PACK_NOT_FOUND');
    const rows: VjPackEventCardRawRow[] = await this.dataSource.manager.query(
      VJ_PACK_EVENT_CARD_SQL,
      [packId],
    );
    const [row] = rows;
    if (!row) {
      throw vjError('VJ_PACK_NOT_FOUND');
    }
    const event = toLinkedEventRow(row);
    if (event === null) {
      return { packId, card: null, unavailableReason: null };
    }
    const unavailableReason = vjEventCardUnavailableReason(event);
    if (unavailableReason !== null) {
      return { packId, card: null, unavailableReason };
    }
    if (
      !isPlatformStaffTier(viewer.role) &&
      (
        await readMemberWithheldEventIds(this.dataSource.manager, [event.id])
      ).has(event.id)
    ) {
      return { packId, card: null, unavailableReason: 'not_listed' };
    }
    return {
      packId,
      card: toVjEventCard(
        event,
        this.config.get<string>('app.frontendUrl'),
        gatheringPath(event.slug),
      ),
      unavailableReason: null,
    };
  }

  /** Links the pack to an event, or unlinks it with `eventId: null`. Checks
   *  the pack id, then the body, then (pack read `FOR UPDATE`) the pack, the
   *  event row and its listing. The event already linked, or null on an
   *  unlinked pack, writes nothing and emits nothing, before the event is
   *  read (plan note 14): an event cancelled since its link still answers
   *  the pack. */
  async setPackEvent(
    requestedPackId: string,
    body: SetVjPackEventDto,
    viewer: VjEventViewer,
  ): Promise<VjPackDTO> {
    const packId = lowercaseIdOrRefuse(requestedPackId, 'VJ_PACK_NOT_FOUND');
    const eventId = readEventIdBody(body.eventId);
    const isChanged = await runVjTransaction(
      this.dataSource,
      (manager) => this.writePackEvent(manager, packId, eventId, viewer),
      PACK_EVENT_LINK_REFUSALS,
    );
    if (isChanged) {
      this.eventEmitter.emit(
        VJ_LIBRARY_CHANGED,
        buildVjLibraryChange('pack_event_changed', { packId, eventId }),
      );
    }
    return this.packAsSeenBy(
      await readVjPackDto(this.dataSource.manager, packId),
      viewer,
    );
  }

  /** The events a pack may link to now, soonest first. A caller outside the
   *  platform staff tiers gets the ones a member could find in the event
   *  listings, so their page can hold fewer than 50. */
  async listUpcomingEvents(
    viewer: VjEventViewer,
  ): Promise<VjEventOptionListDTO> {
    const rows: VjEventRawRow[] = await this.dataSource.manager.query(
      VJ_UPCOMING_EVENTS_SQL,
    );
    const visibleRows = isPlatformStaffTier(viewer.role)
      ? rows
      : await this.withoutMemberWithheld(rows);
    return {
      items: visibleRows.map((row) => toVjEventOption(toVjEventRow(row))),
    };
  }

  /**
   * The packs as this viewer may read them. Admins and moderators get them
   * as they are. A caller outside the platform staff tiers gets each linked
   * event members can no longer see (not listed by status or visibility, or
   * withheld by `VJ_MEMBER_WITHHELD_EVENT_IDS_SQL`) as its id and
   * `isAvailable: false`, with the title and the start left out. One read for
   * the whole list, none when no pack links a listed event.
   */
  async packsAsSeenBy(
    packs: readonly VjPackDTO[],
    viewer: VjEventViewer,
  ): Promise<VjPackDTO[]> {
    if (isPlatformStaffTier(viewer.role)) {
      return [...packs];
    }
    const listedEventIds = packs.flatMap((pack) =>
      pack.event !== null && pack.event.isAvailable ? [pack.event.id] : [],
    );
    const withheldEventIds = await readMemberWithheldEventIds(
      this.dataSource.manager,
      listedEventIds,
    );
    return packs.map((pack) => {
      const event = pack.event;
      if (
        event === null ||
        (event.isAvailable && !withheldEventIds.has(event.id))
      ) {
        return pack;
      }
      return { ...pack, event: { id: event.id, isAvailable: false } };
    });
  }

  /** One pack as this viewer may read it (`packsAsSeenBy`). */
  async packAsSeenBy(
    pack: VjPackDTO,
    viewer: VjEventViewer,
  ): Promise<VjPackDTO> {
    if (isPlatformStaffTier(viewer.role)) {
      return pack;
    }
    const [seenPack] = await this.packsAsSeenBy([pack], viewer);
    return seenPack ?? pack;
  }

  /** The pack list as this viewer may read it (`packsAsSeenBy`). */
  async packListAsSeenBy(
    packList: VjPackListDTO,
    viewer: VjEventViewer,
  ): Promise<VjPackListDTO> {
    if (isPlatformStaffTier(viewer.role)) {
      return packList;
    }
    return {
      ...packList,
      items: await this.packsAsSeenBy(packList.items, viewer),
    };
  }

  /** A pack and its clips as this viewer may read them (`packsAsSeenBy`). */
  async packClipsAsSeenBy(
    packClips: VjPackClipsDTO,
    viewer: VjEventViewer,
  ): Promise<VjPackClipsDTO> {
    if (isPlatformStaffTier(viewer.role)) {
      return packClips;
    }
    return {
      ...packClips,
      pack: await this.packAsSeenBy(packClips.pack, viewer),
    };
  }

  /** The upcoming rows a member could find in the event listings. */
  private async withoutMemberWithheld(
    rows: VjEventRawRow[],
  ): Promise<VjEventRawRow[]> {
    const withheldEventIds = await readMemberWithheldEventIds(
      this.dataSource.manager,
      rows.map((row) => row.id),
    );
    return rows.filter((row) => !withheldEventIds.has(row.id));
  }

  /** The link write inside its transaction; answers whether a row changed.
   *  The table lock comes before the pack row. `updated_at` bumps through
   *  the update. */
  private async writePackEvent(
    manager: EntityManager,
    packId: string,
    eventId: string | null,
    viewer: VjEventViewer,
  ): Promise<boolean> {
    await manager.query(LOCK_VJ_PACKS_ROW_EXCLUSIVE_SQL);
    const pack = await manager.findOne(VjPack, {
      where: { id: packId },
      select: { id: true, eventId: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!pack) {
      throw vjError('VJ_PACK_NOT_FOUND');
    }
    if (pack.eventId === eventId) {
      return false;
    }
    if (eventId !== null) {
      await this.assertEventLinkable(manager, eventId, viewer);
    }
    await manager.update(VjPack, { id: packId }, { eventId });
    return true;
  }

  /** An unknown event answers `VJ_EVENT_NOT_FOUND`; a draft, a cancelled
   *  event or a visibility outside public and members answers
   *  `VJ_EVENT_NOT_LINKABLE`, and so does, for a caller outside the platform
   *  staff tiers, an event members could not find in the event listings.
   *  Reads the id, status and visibility only. */
  private async assertEventLinkable(
    manager: EntityManager,
    eventId: string,
    viewer: VjEventViewer,
  ): Promise<void> {
    const event = await manager.findOne(Event, {
      where: { id: eventId },
      select: { id: true, status: true, visibility: true },
    });
    if (!event) {
      throw vjError('VJ_EVENT_NOT_FOUND');
    }
    if (!isVjEventListed(event)) {
      throw vjError('VJ_EVENT_NOT_LINKABLE');
    }
    if (
      !isPlatformStaffTier(viewer.role) &&
      (await readMemberWithheldEventIds(manager, [event.id])).has(event.id)
    ) {
      throw vjError('VJ_EVENT_NOT_LINKABLE');
    }
  }
}

/** The ids among `eventIds` that `VJ_MEMBER_WITHHELD_EVENT_IDS_SQL` names;
 *  no read for an empty list. */
async function readMemberWithheldEventIds(
  manager: EntityManager,
  eventIds: readonly string[],
): Promise<Set<string>> {
  if (eventIds.length === 0) {
    return new Set<string>();
  }
  const rows: { id: string }[] = await manager.query(
    VJ_MEMBER_WITHHELD_EVENT_IDS_SQL,
    [[...new Set(eventIds)]],
  );
  return new Set(rows.map((row) => row.id));
}

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { extractMentions } from '../common/mentions';
import type {
  CreateEventBatchDto,
  EventBatchRowDto,
} from './dto/create-event-batch.dto';
import {
  AttachableListingRef,
  ListingLookupService,
} from '../listings/listing-lookup.service';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';
import {
  EVENT_BATCH_MAX_ROWS,
  composeBatchEventInput,
  eventBatchDateInPast,
  eventBatchDateTooFar,
  eventBatchDuplicateDate,
  eventBatchRowInvalid,
  eventBatchTooManyDates,
  eventBatchVenueNotFound,
  lastAllowedBatchDate,
  resolveBatchRowSchedule,
  seededCostKind,
  type BatchRowSchedule,
  type CreatedEventBatch,
} from './event-batch';
import {
  EventBatchTemplateService,
  type ResolvedEventBatchTemplate,
} from './event-batch-template.service';
import { eventScheduleProblem } from './event-schedule-rules';
import { EventsService, type CreateEventInput } from './events.service';
import { seatHostAsGoing } from './host-seat';

/** Whether `description` tags anyone (`@member`, `c/`, `b/`, `e/`, `t/`),
 *  read with the same detection the mention fan-out parses with. */
function hasMentionToken(description: string): boolean {
  const mentions = extractMentions(description);
  return (
    mentions.members.length > 0 ||
    mentions.communities.length > 0 ||
    mentions.businesses.length > 0 ||
    mentions.events.length > 0 ||
    mentions.threads.length > 0
  );
}

/** One row that passed every check, with the instants it resolved to. */
interface PlannedBatchRow {
  row: EventBatchRowDto;
  rowIndex: number;
  schedule: BatchRowSchedule;
}

/**
 * Add a month of events: `POST /events/batch` publishes up to
 * `EVENT_BATCH_MAX_ROWS` dated copies of one starting event, all of them or
 * none of them.
 *
 * THE ORDER OF WORK. The row count is checked first, before any read, so an
 * oversized body costs nothing. The starting event is then resolved once for
 * the whole batch (`EventBatchTemplateService.resolveForCaller`), the same
 * read the preview makes, so the page and the write agree on what is copied
 * and what is dropped. A venue the shared block names is checked strictly
 * and answers `EVENT_BATCH_VENUE_NOT_FOUND`; a venue link the starting event
 * carries was already checked by the resolver, which drops it quietly.
 *
 * EVERY ROW IS CHECKED BEFORE ANYTHING IS WRITTEN, in request order, and the
 * first failure answers with the row's index, field and date, so the page can
 * mark the row the host has to fix. A date the body repeats answers on its
 * second row; a date past the 12-month window names the last date allowed; a
 * start already behind `now` answers as a past date; and a schedule the
 * create checks refuse for any other reason answers as an invalid row. The
 * only such schedule a batch row can reach is an end the spring clock change
 * folds onto or before its start. One `now` serves every row, so a batch
 * sent at 20:59 for 21:00 is judged on one clock from its first row to its
 * last.
 *
 * ONE TRANSACTION. Every event row, every slug and every host seat is written
 * through one `dataSource.transaction`, in date order, one awaited write
 * after another on the transaction's single connection. A slug race that
 * exhausts its retries or a host seat that cannot be written on date twenty
 * rolls back the nineteen before it: a month publishes completely or not at
 * all. `EventsService.create` stays outside any transaction, as it always has.
 *
 * WHAT EACH EVENT CARRIES. The starting event's copied fields, then the
 * shared block's overrides, then the row (`composeBatchEventInput`), built
 * into a row by `EventsService.buildNewEventEntity`, the same builder
 * `create` uses, so cost-kind clearing, family stripping and accessibility
 * normalising happen exactly as they do for a single event. That builder
 * gives every event its own copies of the theme, content note, accessibility,
 * RSVP question and format detail values, so the starting event's arrays
 * that every row's input shares are only ever read. Every event is
 * published, sits outside any series, is hosted by the caller (a co-host who
 * starts from the host's event publishes events of their own), takes the
 * starting event's audience, and keeps the community and run by line only
 * when the resolver kept them for this caller.
 *
 * A COST KIND FOR EVERY EVENT. A starting event saved before cost kinds
 * existed holds only its free-text cost. `seededCostKind` reads that text as
 * `free` or `fixed`, the kind the preview already showed the host, so a month
 * started from an old event publishes with the cost kind the page displayed.
 *
 * COVERS. The global upload interceptor has already checked every cover in
 * the body against the caller's own uploads before this runs. The starting
 * event's stored cover is read here, server-side, so a co-host can carry the
 * host's cover onto every date without ever sending its key.
 *
 * NOTIFICATIONS AFTER COMMIT, ONCE PER BATCH. Nothing is announced until the
 * transaction has returned: an ask that cannot be unsent must not describe a
 * write that rolled back (`AppliedEventUpdate`'s reasoning in
 * `EventsService`). Both senders also read through `EventsService`'s own
 * repositories, outside the transaction, so they could not see the rows
 * before the commit anyway. The venue owner is asked once, about the first
 * date, when the venue has an owner and the audience reaches the venue's page
 * (the rule `create` uses); every event is stamped as asked, so no later
 * edit asks again. A member tagged in several descriptions hears once, on the
 * first date whose description tags them: the batch carries the ids already
 * reached from one date to the next. Both are best effort, as in `create`.
 *
 * THE WIZARD'S DRAFT STAYS. `creatorDraftSlots.discardAfterPublish` is not
 * called: the month was built on its own page from an existing event, and a
 * half-written event the host keeps in the create wizard is separate work
 * that stays saved for them to finish.
 */
@Injectable()
export class EventBatchService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly eventsService: EventsService,
    private readonly templates: EventBatchTemplateService,
    private readonly listingLookup: ListingLookupService,
  ) {}

  /** Publishes every row of `dto` as an event hosted by `callerId`, and
   *  answers them in date order. `now` is the one instant every row is
   *  judged against; the spec pins it. */
  async createBatch(
    callerId: string,
    dto: CreateEventBatchDto,
    now: Date = new Date(),
  ): Promise<CreatedEventBatch> {
    if (dto.rows.length > EVENT_BATCH_MAX_ROWS) throw eventBatchTooManyDates();

    const resolved = await this.templates.resolveForCaller(
      dto.templateSlug,
      callerId,
    );
    const { template } = resolved;
    const venueListing = await this.resolveVenueListing(dto, resolved);
    const plannedRows = this.planRows(dto, template.timezone, now);

    const visibilityReachesVenuePage =
      template.visibility === EventVisibility.Public ||
      template.visibility === EventVisibility.Members;
    const shouldAskVenueOwner =
      venueListing !== null &&
      venueListing.ownerId !== null &&
      visibilityReachesVenuePage;
    const venueOwnerNotifiedAt = shouldAskVenueOwner ? now : null;

    const savedEvents = await this.dataSource.transaction(
      async (transactionManager) => {
        const savedInTransaction: Event[] = [];
        for (const { row, schedule } of plannedRows) {
          const input = withSeededCostKind(
            composeBatchEventInput(
              resolved.templateFields,
              dto.shared,
              row,
              schedule,
            ),
          );
          const entity = this.eventsService.buildNewEventEntity(
            callerId,
            input,
            {
              startAt: schedule.startAt,
              endAt: schedule.endAt,
              visibility: template.visibility,
              status: EventStatus.Published,
              communityId: resolved.community?.id ?? null,
              listingId: venueListing?.id ?? null,
              runByListingId: resolved.runByListing?.id ?? null,
              venueOwnerNotifiedAt,
              seriesId: null,
              seriesIndex: null,
            },
          );
          const saved = await this.eventsService.saveWithUniqueSlug(
            entity,
            input.title,
            transactionManager,
          );
          // THE HOST IS GOING on every date, in the same transaction, so a
          // seat that cannot be written takes the whole month back with it.
          await seatHostAsGoing(transactionManager, saved.id, callerId);
          savedInTransaction.push(saved);
        }
        return savedInTransaction;
      },
    );

    // Committed. Every write below is best effort and announces the month.
    // The DTO requires at least one row, so a committed batch always has a
    // first event; the guard only keeps an empty list from asking anybody.
    const [firstEvent] = savedEvents;
    if (shouldAskVenueOwner && venueListing && firstEvent) {
      await this.eventsService.notifyVenueOwnerBestEffort(
        firstEvent,
        venueListing,
      );
    }
    const reachedUserIds = new Set<string>();
    for (const saved of savedEvents) {
      if (!hasMentionToken(saved.description)) continue;
      const reachedNow = await this.eventsService.notifyDescriptionMentions(
        saved,
        saved.description,
        callerId,
        [...reachedUserIds],
      );
      for (const userId of reachedNow) reachedUserIds.add(userId);
    }

    return {
      events: savedEvents.map(({ slug, title, startAt }) => ({
        slug,
        title,
        startAt: startAt.toISOString(),
      })),
    };
  }

  /**
   * The venue listing every event links to. A shared block that sends
   * `listingId` owns the choice: `null` publishes without a link, and a uuid
   * must be attachable now or the batch answers `EVENT_BATCH_VENUE_NOT_FOUND`,
   * since the host picked it on this page and expects it. Otherwise the
   * starting event's link stands as the resolver kept it.
   */
  private async resolveVenueListing(
    dto: CreateEventBatchDto,
    resolved: ResolvedEventBatchTemplate,
  ): Promise<AttachableListingRef | null> {
    if (!Object.prototype.hasOwnProperty.call(dto.shared, 'listingId')) {
      return resolved.venueListing;
    }
    const sharedListingId = dto.shared.listingId;
    if (!sharedListingId) return null;
    const venueListing =
      await this.listingLookup.findAttachable(sharedListingId);
    if (!venueListing) throw eventBatchVenueNotFound();
    return venueListing;
  }

  /**
   * Every row checked in request order and resolved to its instants, then
   * sorted into date order (ascending start, ties in request order). Throws
   * the first row error it meets, before anything is written.
   */
  private planRows(
    dto: CreateEventBatchDto,
    timeZone: string,
    now: Date,
  ): PlannedBatchRow[] {
    const lastDate = lastAllowedBatchDate(now, timeZone);
    const seenDates = new Set<string>();
    const plannedRows: PlannedBatchRow[] = [];
    for (const [rowIndex, row] of dto.rows.entries()) {
      if (seenDates.has(row.date)) {
        throw eventBatchDuplicateDate(rowIndex, row.date);
      }
      seenDates.add(row.date);
      // `YYYY-MM-DD` strings compare in calendar order.
      if (row.date > lastDate) {
        throw eventBatchDateTooFar(rowIndex, row.date, lastDate);
      }
      const schedule = resolveBatchRowSchedule(row, dto.shared, timeZone);
      const problem = eventScheduleProblem(schedule.startAt, schedule.endAt, {
        rejectPast: true,
        now,
      });
      if (problem === 'startInPast') {
        throw eventBatchDateInPast(rowIndex, row.date);
      }
      if (problem !== null) throw eventBatchRowInvalid(rowIndex, row.date);
      plannedRows.push({ row, rowIndex, schedule });
    }
    return plannedRows.sort(
      (first, second) =>
        first.schedule.startAt.getTime() - second.schedule.startAt.getTime() ||
        first.rowIndex - second.rowIndex,
    );
  }
}

/** `input` with the cost kind `seededCostKind` reads for it. Answers a new
 *  object and leaves `input` as it was. */
function withSeededCostKind(input: CreateEventInput): CreateEventInput {
  if (input.costKind) return input;
  return { ...input, costKind: seededCostKind(input.costKind, input.cost) };
}

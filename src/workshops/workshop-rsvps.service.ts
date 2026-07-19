import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import {
  WorkshopRsvp,
  WorkshopRsvpStatus,
} from './entities/workshop-rsvp.entity';
import { Workshop } from './entities/workshop.entity';

/** What `POST`/`DELETE /workshops/:slug/rsvp` answer with. `spotsFilled` is
 *  always the freshly derived count, so the sidebar's "3 / 8" updates from the
 *  same response that changed it. */
export interface WorkshopRsvpResult {
  status: 'going' | 'waitlist';
  spotsFilled: number;
  spotsTotal: number;
}

/**
 * Reservations for workshops.
 *
 * A separate service from `WorkshopsService` for the same reason `events` keeps
 * `RsvpService` apart from `EventsService`: the catalogue is read-mostly and
 * host-gated, while this is a contended write path that owns a transaction and
 * a row lock. Splitting them keeps that lock scoped to the code that needs it.
 */
@Injectable()
export class WorkshopRsvpsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(WorkshopRsvp)
    private readonly rsvps: Repository<WorkshopRsvp>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly blockFilter: BlockFilterService,
  ) {}

  /**
   * Book a seat, or join the queue when the cohort is full.
   *
   * **The capacity race is closed by a pessimistic write lock on the workshop
   * row**, inside the transaction that then counts and writes — the mechanism
   * `RsvpService.rsvp` uses (`lock: { mode: 'pessimistic_write' }` on the parent
   * `Event`) and that `VolunteeringService.signup` copied for the same reason.
   * Two members going for the last seat both `SELECT … FOR UPDATE` the same
   * `workshops` row, so the second one blocks until the first has committed its
   * insert; its subsequent `COUNT` therefore sees the seat already taken and it
   * lands on the waitlist. A bare count-then-insert without the lock is exactly
   * the read-then-write that oversells, because both counts run before either
   * insert.
   *
   * The `UQ_workshop_rsvps` unique constraint is a backstop for a *different*
   * race — one member double-submitting against themselves — not for capacity.
   * Here it can't even fire, because the same lock serializes both submissions
   * and the second one finds `existing` and updates it.
   *
   * Idempotent: re-booking when you already have a seat returns that seat, and
   * pressing the button again while queued keeps your place rather than sending
   * you to the back of the line (the `waitlistedAt` stamp is only set on entry).
   */
  async rsvp(slug: string, userId: string): Promise<WorkshopRsvpResult> {
    return this.dataSource.transaction(async (manager) => {
      const workshop = await manager.findOne(Workshop, {
        where: { slug },
        lock: { mode: 'pessimistic_write' },
      });
      if (!workshop) {
        throw new NotFoundException('Workshop not found');
      }
      // The host is already in the room — they are teaching it. Letting them
      // take a seat would consume one of the `spots_total` they are teaching to.
      if (workshop.hostId === userId) {
        throw new ForbiddenException('You are hosting this workshop');
      }

      const rsvpRepo = manager.getRepository(WorkshopRsvp);
      const existing = await rsvpRepo.findOne({
        where: { workshopId: workshop.id, userId },
      });
      if (existing && existing.status !== WorkshopRsvpStatus.Cancelled) {
        // Already going or already queued — return the standing answer
        // untouched, so a double-tap can't reshuffle the queue.
        return this.result(
          rsvpRepo,
          workshop,
          existing.status === WorkshopRsvpStatus.Going ? 'going' : 'waitlist',
        );
      }

      const going = await this.countGoing(rsvpRepo, workshop.id);
      const full = going >= workshop.spotsTotal;
      const next: WorkshopRsvpStatus = full
        ? WorkshopRsvpStatus.Waitlist
        : WorkshopRsvpStatus.Going;

      await rsvpRepo.save(
        rsvpRepo.create({
          // Reuse the existing (cancelled) row so the UNIQUE pair stays the one
          // place this member's relationship to this workshop lives.
          ...(existing ? { id: existing.id } : {}),
          workshopId: workshop.id,
          userId,
          status: next,
          waitlistedAt: full ? new Date() : null,
        }),
      );

      return this.result(rsvpRepo, workshop, full ? 'waitlist' : 'going');
    });
  }

  /**
   * Give the seat back. Idempotent — cancelling a booking you don't have is a
   * no-op, not a 404 (the route answers 204 either way), matching
   * `RsvpService.cancelRsvp` and `VolunteeringService.withdraw`.
   *
   * Freeing a `going` seat promotes the head of the waitlist inside the same
   * locked transaction, so the seat can never be handed to two people.
   */
  async cancelRsvp(slug: string, userId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const workshop = await manager.findOne(Workshop, {
        where: { slug },
        lock: { mode: 'pessimistic_write' },
      });
      if (!workshop) {
        throw new NotFoundException('Workshop not found');
      }

      const rsvpRepo = manager.getRepository(WorkshopRsvp);
      const mine = await rsvpRepo.findOne({
        where: { workshopId: workshop.id, userId },
      });
      if (!mine || mine.status === WorkshopRsvpStatus.Cancelled) {
        return;
      }

      const wasGoing = mine.status === WorkshopRsvpStatus.Going;
      mine.status = WorkshopRsvpStatus.Cancelled;
      mine.waitlistedAt = null;
      await rsvpRepo.save(mine);

      if (wasGoing) {
        await this.promoteWaitlist(rsvpRepo, workshop);
      }
    });
  }

  /**
   * Who is coming.
   *
   * **Attendees are visible to the host and to fellow attendees only** — a
   * member who is not on the roster (going or queued) gets a 403.
   *
   * This is narrower than `events`, which lets anyone who can *view* the event
   * read its guest list, and the difference is deliberate. An event's audience
   * is already scoped by its own visibility setting (public / members /
   * invite-only), so "can view" is a meaningful gate there. A workshop has no
   * visibility field: every workshop is in a catalogue any active member can
   * browse. Reusing "can view" would therefore make every roster readable by
   * the entire membership, turning a public listing into a directory of who is
   * learning what — the kind of enumeration a queer community platform should
   * not hand out for free. Sharing a room is the thing that earns you the list
   * of who else is in it.
   *
   * Blocks are filtered post-query with `blockedUserIds`, following
   * `EventsService.attendees`: **blocks only, never mutes**. A block is a
   * mutual severance and the blocked member must not surface in a list the
   * viewer reads; a mute silences someone's content in a feed and was never a
   * statement about who may share a room. Dropping muted members here would
   * misreport who is actually going, which a viewer may need for their own
   * safety planning. Post-query is sound because this returns the whole roster
   * with no LIMIT — there is no page to under-fill.
   */
  async attendees(slug: string, viewerId: string): Promise<MemberRef[]> {
    const workshop = await this.workshopOr404(slug, this.rsvps.manager);
    const isHost = workshop.hostId === viewerId;

    const roster = await this.rsvps.find({
      where: {
        workshopId: workshop.id,
        status: In([WorkshopRsvpStatus.Going, WorkshopRsvpStatus.Waitlist]),
      },
      // Seated members first, then the queue in the order it formed.
      order: { status: 'ASC', waitlistedAt: 'ASC' },
    });

    if (!isHost && !roster.some((r) => r.userId === viewerId)) {
      throw new ForbiddenException(
        'Only the host and people attending can see who is coming',
      );
    }

    const blocked = await this.blockFilter.blockedUserIds(
      viewerId,
      roster.map((r) => r.userId),
    );
    const visible = roster.filter((r) => !blocked.has(r.userId));
    const members = await new MemberLookup(this.profiles).byUserIds(
      visible.map((r) => r.userId),
    );
    // Drop profile-less ghost rows, as `EventsService.attendees` does.
    return visible
      .map((r) => members.get(r.userId))
      .filter((m): m is MemberRef => !!m);
  }

  // --- read helpers used by WorkshopsService to build DTOs -----------------

  /** Derived `spots_filled` for one workshop (the dropped stored column). */
  async spotsFilledFor(workshopId: string): Promise<number> {
    return this.countGoing(this.rsvps, workshopId);
  }

  /**
   * Grouped counterpart for a whole page of workshops — one query instead of
   * N+1, mirroring `VolunteeringService.spotsFilledForMany`.
   */
  async spotsFilledForMany(
    workshopIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>(workshopIds.map((id) => [id, 0]));
    if (!workshopIds.length) return result;

    const rows = await this.rsvps
      .createQueryBuilder('r')
      .select('r.workshop_id', 'workshopId')
      .addSelect('COUNT(*)', 'count')
      .where('r.workshop_id IN (:...ids) AND r.status = :status', {
        ids: workshopIds,
        status: WorkshopRsvpStatus.Going,
      })
      .groupBy('r.workshop_id')
      .getRawMany<{ workshopId: string; count: string }>();

    for (const row of rows) {
      result.set(row.workshopId, Number(row.count));
    }
    return result;
  }

  /** The viewer's own standing, for the detail DTO. `null` = not booked. */
  async myStatusFor(
    workshopId: string,
    userId: string,
  ): Promise<'going' | 'waitlist' | null> {
    const mine = await this.rsvps.findOne({
      where: { workshopId, userId },
    });
    if (!mine || mine.status === WorkshopRsvpStatus.Cancelled) return null;
    return mine.status === WorkshopRsvpStatus.Going ? 'going' : 'waitlist';
  }

  // --- internals -----------------------------------------------------------

  private async workshopOr404(
    slug: string,
    manager: EntityManager,
  ): Promise<Workshop> {
    const workshop = await manager.findOne(Workshop, { where: { slug } });
    if (!workshop) {
      throw new NotFoundException('Workshop not found');
    }
    return workshop;
  }

  private async countGoing(
    repo: Repository<WorkshopRsvp>,
    workshopId: string,
  ): Promise<number> {
    return repo.count({
      where: { workshopId, status: WorkshopRsvpStatus.Going },
    });
  }

  /**
   * Pull the head(s) of the queue into the freed seat(s).
   *
   * Loops rather than promoting exactly one, so it stays correct if capacity is
   * ever raised by an edit — the same shape as `RsvpService.promoteWaitlist`.
   *
   * The promoted member is **not notified**: there is no email service, and no
   * workshop notification type exists to raise. They see the change the next
   * time they open the workshop. Nothing in the UI claims otherwise.
   */
  private async promoteWaitlist(
    repo: Repository<WorkshopRsvp>,
    workshop: Workshop,
  ): Promise<void> {
    for (;;) {
      const going = await this.countGoing(repo, workshop.id);
      if (going >= workshop.spotsTotal) {
        return;
      }
      const head = await repo.findOne({
        where: { workshopId: workshop.id, status: WorkshopRsvpStatus.Waitlist },
        order: { waitlistedAt: 'ASC' },
      });
      if (!head) {
        return;
      }
      head.status = WorkshopRsvpStatus.Going;
      head.waitlistedAt = null;
      await repo.save(head);
    }
  }

  private async result(
    repo: Repository<WorkshopRsvp>,
    workshop: Workshop,
    status: 'going' | 'waitlist',
  ): Promise<WorkshopRsvpResult> {
    return {
      status,
      spotsFilled: await this.countGoing(repo, workshop.id),
      spotsTotal: workshop.spotsTotal,
    };
  }
}

import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { EventAttendanceRetentionService } from './event-attendance-retention.service';
import { EventRsvp } from './entities/event-rsvp.entity';

/**
 * The sweep is ONE statement, so what a unit test can pin is the statement it
 * builds: the clock it measures from, the columns it nulls, the guard that
 * stops it rewriting the same rows forever, and the batching. Row-level SQL
 * semantics (that `COALESCE` really does pick `end_at`, that the join really
 * does exclude a deleted gathering) are the database's job and belong in the
 * e2e layer, which runs against a real Postgres.
 *
 * Every assertion below corresponds to a decision documented on the service:
 * lose one and the promised retention period quietly stops being honoured, or
 * starts destroying something a host or the member still needs.
 */
describe('EventAttendanceRetentionService', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  let config: { get: jest.Mock };
  let execute: jest.Mock;
  let set: jest.Mock;
  let where: jest.Mock;
  let update: jest.Mock;
  let builder: Record<string, unknown>;
  let rsvps: { createQueryBuilder: jest.Mock };
  let service: EventAttendanceRetentionService;

  const settings: Record<string, number> = {};

  /** The `where(sql, params)` call from the Nth batch of the last run. */
  const whereCall = (index = 0) =>
    where.mock.calls[index] as [string, Record<string, unknown>];

  /** The `set({...})` payload from the Nth batch of the last run. */
  const setCall = (index = 0) =>
    (set.mock.calls[index] as [Record<string, unknown>])[0];

  beforeEach(() => {
    Object.keys(settings).forEach((key) => delete settings[key]);
    settings['retention.eventAttendanceDays'] = 30;
    settings['retention.batchSize'] = 1000;
    settings['retention.maxBatchesPerRun'] = 50;

    config = {
      get: jest.fn(
        (key: string, fallback?: number) => settings[key] ?? fallback,
      ),
    };

    // One batch that clears nothing, so the loop stops after a single pass
    // unless a test says otherwise.
    execute = jest.fn().mockResolvedValue({ affected: 0 });
    set = jest.fn().mockReturnThis();
    where = jest.fn().mockReturnThis();
    update = jest.fn().mockReturnThis();
    builder = { update, set, where, execute };
    rsvps = { createQueryBuilder: jest.fn().mockReturnValue(builder) };

    service = new EventAttendanceRetentionService(
      rsvps as unknown as Repository<EventRsvp>,
      config as unknown as ConfigService,
    );
  });

  describe('what it clears', () => {
    it('nulls the check-in stamp and the two free-text needs fields, and nothing else', async () => {
      // THE central decision. `checked_in_at` is the record that this member
      // physically attended; `access_needs`/`dietary_needs` are free text that
      // routinely carries health, disability or religion. Widening this set
      // starts destroying data a host or the member still needs; narrowing it
      // stops honouring the published period.
      await service.clearPastEventAttendance();
      expect(setCall()).toEqual({
        checkedInAt: null,
        accessNeeds: null,
        dietaryNeeds: null,
      });
    });

    it('keeps the row rather than deleting it', async () => {
      // Deleting would zero the headcount of every past gathering, because
      // `goingCount`/`seatsTaken`/`waitlistCount` are aggregated from these
      // rows at read time and are stored nowhere else. It would also drop
      // `removed_by_host_at`, which is a safety record.
      await service.clearPastEventAttendance();
      expect(update).toHaveBeenCalledWith(EventRsvp);
      // The query builder this service is handed exposes no delete path at
      // all, so a future edit cannot reach for one without also changing the
      // shape this spec constructs.
      expect(builder).not.toHaveProperty('delete');
    });

    it('leaves the countable and safety columns out of the SET entirely', async () => {
      await service.clearPastEventAttendance();
      const cleared = setCall();
      for (const kept of [
        'status',
        'guestCount',
        'waitlistPosition',
        'removedByHostAt',
        'eventId',
        'userId',
        'visibility',
      ]) {
        expect(cleared).not.toHaveProperty(kept);
      }
    });
  });

  describe('the clock', () => {
    it('measures from when the gathering ENDED, never from when the RSVP was created', async () => {
      // An RSVP placed in January for a gathering in June must not clear in
      // February. `COALESCE(end_at, start_at)` also means a multi-day
      // gathering is measured from its last day, so it is never cleared while
      // it is still running.
      await service.clearPastEventAttendance();
      const [sql] = whereCall();
      expect(sql).toContain('COALESCE(event.end_at, event.start_at) < :cutoff');
      expect(sql).not.toContain('rsvp.created_at');
    });

    it('sets the cutoff to the configured number of days ago', async () => {
      const before = Date.now();
      await service.clearPastEventAttendance();
      const after = Date.now();

      const [, parameters] = whereCall();
      const cutoff = parameters.cutoff as Date;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * DAY_MS);
      expect(cutoff.getTime()).toBeLessThanOrEqual(after - 30 * DAY_MS);
    });

    it('honours a shorter configured window', async () => {
      settings['retention.eventAttendanceDays'] = 7;
      const before = Date.now();
      await service.clearPastEventAttendance();

      const [, parameters] = whereCall();
      const cutoff = parameters.cutoff as Date;
      expect(cutoff.getTime()).toBeLessThanOrEqual(before - 7 * DAY_MS + 1000);
      expect(cutoff.getTime()).toBeGreaterThan(before - 8 * DAY_MS);
    });

    it('falls back to 30 days when the setting is absent', async () => {
      // The published promise is the default, so a missing config value must
      // never widen the window.
      delete settings['retention.eventAttendanceDays'];
      const before = Date.now();
      await service.clearPastEventAttendance();

      const [, parameters] = whereCall();
      const cutoff = parameters.cutoff as Date;
      expect(cutoff.getTime()).toBeLessThanOrEqual(before - 30 * DAY_MS + 1000);
      expect(cutoff.getTime()).toBeGreaterThan(before - 31 * DAY_MS);
    });
  });

  describe('which gatherings it covers', () => {
    it('does not exclude cancelled gatherings', async () => {
      // Deliberate: nobody attended a cancelled gathering, so there is no
      // attendance worth keeping, and the access/dietary notes members left
      // for it are pure liability. A `status` filter appearing here would be a
      // regression.
      await service.clearPastEventAttendance();
      const [sql] = whereCall();
      expect(sql).not.toContain('event.status');
      expect(sql).not.toContain("'cancelled'");
    });

    it('reads the gathering through a join, so a deleted one leaves nothing behind', async () => {
      // `FK_event_rsvps_event_id` is ON DELETE CASCADE, so an RSVP cannot
      // outlive its gathering; the join documents that the sweep only ever
      // considers RSVPs whose gathering still exists.
      await service.clearPastEventAttendance();
      const [sql] = whereCall();
      expect(sql).toContain('JOIN events event ON event.id = rsvp.event_id');
    });
  });

  describe('convergence', () => {
    it('skips rows that are already clear', async () => {
      // Without this the sweep rewrites the same rows every night forever and
      // the logged count means nothing.
      await service.clearPastEventAttendance();
      const [sql] = whereCall();
      expect(sql).toContain('rsvp.checked_in_at IS NOT NULL');
      expect(sql).toContain('rsvp.access_needs IS NOT NULL');
      expect(sql).toContain('rsvp.dietary_needs IS NOT NULL');
    });

    it('bounds every statement with a primary-key subselect and a LIMIT', async () => {
      await service.clearPastEventAttendance();
      const [sql, parameters] = whereCall();
      expect(sql).toContain('id IN (');
      expect(sql).toContain('LIMIT :batchSize');
      expect(parameters.batchSize).toBe(1000);
    });
  });

  describe('batching', () => {
    it('stops as soon as a batch clears fewer rows than the batch size', async () => {
      settings['retention.batchSize'] = 10;
      execute.mockResolvedValueOnce({ affected: 4 });
      await service.clearPastEventAttendance();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('keeps going while every batch comes back full', async () => {
      settings['retention.batchSize'] = 10;
      execute
        .mockResolvedValueOnce({ affected: 10 })
        .mockResolvedValueOnce({ affected: 10 })
        .mockResolvedValueOnce({ affected: 3 });
      await service.clearPastEventAttendance();
      expect(execute).toHaveBeenCalledTimes(3);
    });

    it('never exceeds maxBatchesPerRun in one tick', async () => {
      // The safety valve: a backlog larger than one run is finished by the
      // next tick rather than by looping unbounded here.
      settings['retention.batchSize'] = 10;
      settings['retention.maxBatchesPerRun'] = 3;
      execute.mockResolvedValue({ affected: 10 });
      await service.clearPastEventAttendance();
      expect(execute).toHaveBeenCalledTimes(3);
    });
  });

  describe('failure containment', () => {
    it('swallows and logs a database error instead of rejecting', async () => {
      // @nestjs/schedule does not wrap handlers, so an escaping rejection
      // becomes an unhandledRejection that can take the process down. A blip
      // must cost one skipped night, never the server.
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      execute.mockRejectedValue(new Error('connection terminated'));

      await expect(service.clearPastEventAttendance()).resolves.toBeUndefined();
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('Event-attendance retention failed'),
      );
      logError.mockRestore();
    });

    it('stays quiet when there was nothing to clear', async () => {
      const logMessage = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      await service.clearPastEventAttendance();
      expect(logMessage).not.toHaveBeenCalled();
      logMessage.mockRestore();
    });

    it('reports how many rows it cleared when it cleared some', async () => {
      settings['retention.batchSize'] = 10;
      execute.mockResolvedValueOnce({ affected: 4 });
      const logMessage = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      await service.clearPastEventAttendance();
      expect(logMessage).toHaveBeenCalledWith(
        expect.stringContaining('4 RSVP(s)'),
      );
      logMessage.mockRestore();
    });
  });
});

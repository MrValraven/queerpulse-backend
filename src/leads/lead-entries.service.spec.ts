import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { UserRole } from '../users/entities/user.entity';
import { LeadEntry } from './entities/lead-entry.entity';
import { Lead } from './entities/lead.entity';
import { LeadEntriesService, TOUCH_LEAD_SQL } from './lead-entries.service';
import type { LeadCaller, LeadDTO } from './lead-response';
import {
  LEAD_REVERT_WINDOW_MS,
  type LeadRevertRefusalReason,
} from './leads.constants';
import { LeadsService, LOCK_LEADS_SQL } from './leads.service';

const ADMIN_ID = 'd7500000-0000-4000-8000-000000000001';
const HOLDER_ID = 'd7500000-0000-4000-8000-000000000002';
const OTHER_MEMBER_ID = 'd7500000-0000-4000-8000-000000000003';
const LEAD_ID = 'd7500000-0000-4000-8000-000000000011';
const OTHER_LEAD_ID = 'd7500000-0000-4000-8000-000000000012';
const ENTRY_ID = 'd7500000-0000-4000-8000-000000000021';
const NEWER_ENTRY_ID = 'd7500000-0000-4000-8000-000000000022';

const ADMIN: LeadCaller = { userId: ADMIN_ID, role: UserRole.Admin };
const GRANT_HOLDER: LeadCaller = { userId: HOLDER_ID, role: UserRole.Member };

const REFRESHED_LEAD = { id: LEAD_ID, entries: [] } as unknown as LeadDTO;

interface RefusalOutcome {
  code?: string;
  status?: number;
}

async function codeOf(promise: Promise<unknown>): Promise<RefusalOutcome> {
  try {
    await promise;
    return {};
  } catch (error) {
    const httpError = error as HttpException;
    const body = httpError.getResponse() as { code?: string };
    return { code: body.code, status: httpError.getStatus() };
  }
}

interface RevertRefusalOutcome extends RefusalOutcome {
  reason?: string;
}

/** The code, status and `reason` of a refused call, or `{}` when it
 *  resolved. */
async function revertRefusalOf(
  promise: Promise<unknown>,
): Promise<RevertRefusalOutcome> {
  try {
    await promise;
    return {};
  } catch (error) {
    const httpError = error as HttpException;
    const body = httpError.getResponse() as { code?: string; reason?: string };
    const outcome: RevertRefusalOutcome = {
      code: body.code,
      status: httpError.getStatus(),
    };
    if (body.reason !== undefined) {
      outcome.reason = body.reason;
    }
    return outcome;
  }
}

/** The global call order of one call of a mock. Throws when that call never
 *  happened, so an order assertion can not pass on a missing call. */
function callOrderOf(mockFunction: jest.Mock, callIndex = 0): number {
  const callOrder = mockFunction.mock.invocationCallOrder[callIndex];
  if (callOrder === undefined) {
    throw new Error(`Call ${callIndex} of the mock never happened`);
  }
  return callOrder;
}

function buildEntry(overrides: Partial<LeadEntry> = {}): LeadEntry {
  return {
    id: ENTRY_ID,
    leadId: LEAD_ID,
    kind: 'note',
    body: 'first text',
    fromStage: null,
    toStage: null,
    subprofileId: null,
    authorId: HOLDER_ID,
    createdAt: new Date('2026-06-03T09:00:00.000Z'),
    editedAt: null,
    ...overrides,
  };
}

describe('LeadEntriesService', () => {
  let manager: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock; manager: typeof manager };
  let leads: { getLead: jest.Mock };
  let service: LeadEntriesService;
  let storedLead: (Pick<Lead, 'id'> & Partial<Pick<Lead, 'stage'>>) | null;
  let storedEntry: LeadEntry | null;
  /** What the newest `stage_changed` read of a lead answers. */
  let newestStageChange: Pick<LeadEntry, 'id'> | null;

  /** Whether any write ran: an insert, update, delete or the stamp. The
   *  table lock is no write, so it is left out. */
  function hasWritten(): boolean {
    const writeQueries = manager.query.mock.calls.filter(
      (call: unknown[]) => call[0] !== LOCK_LEADS_SQL,
    );
    return (
      manager.save.mock.calls.length > 0 ||
      manager.update.mock.calls.length > 0 ||
      manager.delete.mock.calls.length > 0 ||
      writeQueries.length > 0
    );
  }

  /** The global call order of the first `manager.query` call running `sql`.
   *  Throws when no call ran it. */
  function queryCallOrderOf(sql: string): number {
    const callIndex = manager.query.mock.calls.findIndex(
      (call: unknown[]) => call[0] === sql,
    );
    if (callIndex === -1) {
      throw new Error('No query call ran this SQL');
    }
    return callOrderOf(manager.query, callIndex);
  }

  /** The first query of the write is the leads table lock, and it runs
   *  before the lead row lock. */
  function expectTableLockFirst(): void {
    expect(manager.query.mock.calls[0]).toEqual([LOCK_LEADS_SQL]);
    expect(callOrderOf(manager.query)).toBeLessThan(
      callOrderOf(manager.findOne),
    );
  }

  beforeEach(() => {
    storedLead = { id: LEAD_ID };
    storedEntry = buildEntry();
    newestStageChange = null;
    manager = {
      findOne: jest.fn(
        (entity: unknown, options: { where: Record<string, unknown> }) => {
          if (entity === Lead) return Promise.resolve(storedLead);
          if (entity === LeadEntry && 'kind' in options.where) {
            return Promise.resolve(newestStageChange);
          }
          if (entity === LeadEntry) {
            const isOnLead =
              storedEntry !== null &&
              storedEntry.id === options.where.id &&
              storedEntry.leadId === options.where.leadId;
            return Promise.resolve(isOnLead ? storedEntry : null);
          }
          return Promise.resolve(null);
        },
      ),
      create: jest.fn((_entity: unknown, row: object) => ({ ...row })),
      save: jest.fn((_entity: unknown, row: object) =>
        Promise.resolve({ ...row, id: ENTRY_ID }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn().mockResolvedValue([]),
    };
    dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
      manager,
    };
    leads = { getLead: jest.fn().mockResolvedValue(REFRESHED_LEAD) };
    service = new LeadEntriesService(
      dataSource as unknown as DataSource,
      leads as unknown as LeadsService,
    );
  });

  describe('addNote', () => {
    it('checks a note add in the contract order', async () => {
      expect(
        await codeOf(service.addNote('not-a-uuid', ADMIN, { body: '  ' })),
      ).toEqual({ code: 'LEAD_NOT_FOUND', status: 404 });
      expect(
        await codeOf(service.addNote(LEAD_ID, ADMIN, { body: '  ' })),
      ).toEqual({ code: 'LEAD_NOTE_EMPTY', status: 400 });
      expect(
        await codeOf(service.addNote(LEAD_ID, ADMIN, { body: 42 })),
      ).toEqual({ code: 'LEAD_NOTE_EMPTY', status: 400 });
      expect(
        await codeOf(
          service.addNote(LEAD_ID, ADMIN, { body: '🌈'.repeat(4001) }),
        ),
      ).toEqual({ code: 'LEAD_NOTE_TOO_LONG', status: 400 });
      expect(dataSource.transaction).not.toHaveBeenCalled();

      storedLead = null;

      expect(
        await codeOf(service.addNote(LEAD_ID, ADMIN, { body: 'hello' })),
      ).toEqual({ code: 'LEAD_NOT_FOUND', status: 404 });
      expect(hasWritten()).toBe(false);
    });

    it('adds the note as the caller and touches the lead', async () => {
      const lead = await service.addNote(LEAD_ID, GRANT_HOLDER, {
        body: '  trimmed\nsecond line  ',
      });

      expect(manager.findOne).toHaveBeenCalledWith(Lead, {
        where: { id: LEAD_ID },
        select: { id: true },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.save).toHaveBeenCalledWith(LeadEntry, {
        leadId: LEAD_ID,
        kind: 'note',
        body: 'trimmed\nsecond line',
        authorId: HOLDER_ID,
      });
      expectTableLockFirst();
      expect(manager.query).toHaveBeenCalledWith(TOUCH_LEAD_SQL, [LEAD_ID]);
      expect(callOrderOf(manager.save)).toBeLessThan(
        queryCallOrderOf(TOUCH_LEAD_SQL),
      );
      expect(leads.getLead).toHaveBeenCalledWith(LEAD_ID, GRANT_HOLDER);
      expect(callOrderOf(dataSource.transaction)).toBeLessThan(
        callOrderOf(leads.getLead),
      );
      expect(lead).toBe(REFRESHED_LEAD);
    });
  });

  describe('editNote', () => {
    it.each<{
      label: string;
      leadId: string;
      entryId: string;
      caller: LeadCaller;
      body: unknown;
      arrange?: () => void;
      code: string;
      status: number;
    }>([
      {
        label: 'a malformed lead id',
        leadId: 'not-a-uuid',
        entryId: 'not-a-uuid',
        caller: ADMIN,
        body: { body: '' },
        code: 'LEAD_NOT_FOUND',
        status: 404,
      },
      {
        label: 'a malformed entry id',
        leadId: LEAD_ID,
        entryId: 'not-a-uuid',
        caller: ADMIN,
        body: { body: '' },
        code: 'LEAD_NOTE_NOT_FOUND',
        status: 404,
      },
      {
        label: 'a blank body',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: ADMIN,
        body: { body: ' \n ' },
        code: 'LEAD_NOTE_EMPTY',
        status: 400,
      },
      {
        label: 'a long body',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: ADMIN,
        body: { body: 'a'.repeat(4001) },
        code: 'LEAD_NOTE_TOO_LONG',
        status: 400,
      },
      {
        label: 'an unknown lead',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: ADMIN,
        body: { body: 'new text' },
        arrange: () => {
          storedLead = null;
        },
        code: 'LEAD_NOT_FOUND',
        status: 404,
      },
      {
        label: 'an entry on another lead',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: ADMIN,
        body: { body: 'new text' },
        arrange: () => {
          storedEntry = buildEntry({ leadId: OTHER_LEAD_ID });
        },
        code: 'LEAD_NOTE_NOT_FOUND',
        status: 404,
      },
      {
        label: 'a stage_changed entry, even for its author',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: GRANT_HOLDER,
        body: { body: 'new text' },
        arrange: () => {
          storedEntry = buildEntry({
            kind: 'stage_changed',
            body: null,
            fromStage: 'to_contact',
            toStage: 'contacted',
            authorId: HOLDER_ID,
          });
        },
        code: 'LEAD_ENTRY_NOT_EDITABLE',
        status: 409,
      },
      {
        label: "another member's note for a grant holder",
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: GRANT_HOLDER,
        body: { body: 'new text' },
        arrange: () => {
          storedEntry = buildEntry({ authorId: OTHER_MEMBER_ID });
        },
        code: 'LEAD_NOTE_NOT_YOURS',
        status: 403,
      },
    ])(
      'answers $code for $label and writes nothing',
      async ({ leadId, entryId, caller, body, arrange, code, status }) => {
        arrange?.();

        expect(
          await codeOf(service.editNote(leadId, entryId, caller, body)),
        ).toEqual({ code, status });
        expect(hasWritten()).toBe(false);
        expect(leads.getLead).not.toHaveBeenCalled();
      },
    );

    it('lets an Admin edit any note, including one whose author is gone', async () => {
      storedEntry = buildEntry({ authorId: null });

      const lead = await service.editNote(LEAD_ID, ENTRY_ID, ADMIN, {
        body: ' new text ',
      });

      expect(manager.findOne).toHaveBeenCalledWith(LeadEntry, {
        where: { id: ENTRY_ID, leadId: LEAD_ID },
      });
      expect(manager.update).toHaveBeenCalledWith(LeadEntry, ENTRY_ID, {
        body: 'new text',
        editedAt: expect.any(Function) as () => string,
      });
      const [updateCall] = manager.update.mock.calls as [
        [unknown, string, { editedAt: () => string }],
      ];
      const updateValues = updateCall[2];
      expect(updateValues.editedAt()).toBe('now()');
      expectTableLockFirst();
      expect(manager.query).toHaveBeenCalledWith(TOUCH_LEAD_SQL, [LEAD_ID]);
      expect(callOrderOf(manager.update)).toBeLessThan(
        queryCallOrderOf(TOUCH_LEAD_SQL),
      );
      expect(leads.getLead).toHaveBeenCalledWith(LEAD_ID, ADMIN);
      expect(lead).toBe(REFRESHED_LEAD);
    });

    it('lets the author edit their own note', async () => {
      await service.editNote(LEAD_ID, ENTRY_ID, GRANT_HOLDER, {
        body: 'new text',
      });

      expect(manager.update).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(TOUCH_LEAD_SQL, [LEAD_ID]);
    });

    it('treats an unchanged body as a no-op', async () => {
      const lead = await service.editNote(LEAD_ID, ENTRY_ID, GRANT_HOLDER, {
        body: '  first text ',
      });

      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.query.mock.calls).toEqual([[LOCK_LEADS_SQL]]);
      expect(leads.getLead).toHaveBeenCalledWith(LEAD_ID, GRANT_HOLDER);
      expect(lead).toBe(REFRESHED_LEAD);
    });
  });

  describe('deleteNote', () => {
    it('deletes a note with the edit order minus the body checks', async () => {
      expect(
        await codeOf(service.deleteNote('not-a-uuid', 'not-a-uuid', ADMIN)),
      ).toEqual({ code: 'LEAD_NOT_FOUND', status: 404 });
      expect(
        await codeOf(service.deleteNote(LEAD_ID, 'not-a-uuid', ADMIN)),
      ).toEqual({ code: 'LEAD_NOTE_NOT_FOUND', status: 404 });

      storedLead = null;
      expect(
        await codeOf(service.deleteNote(LEAD_ID, ENTRY_ID, ADMIN)),
      ).toEqual({ code: 'LEAD_NOT_FOUND', status: 404 });
      storedLead = { id: LEAD_ID };

      storedEntry = buildEntry({ leadId: OTHER_LEAD_ID });
      expect(
        await codeOf(service.deleteNote(LEAD_ID, ENTRY_ID, ADMIN)),
      ).toEqual({ code: 'LEAD_NOTE_NOT_FOUND', status: 404 });

      storedEntry = buildEntry({
        kind: 'created',
        body: null,
        toStage: 'to_contact',
        authorId: HOLDER_ID,
      });
      expect(
        await codeOf(service.deleteNote(LEAD_ID, ENTRY_ID, GRANT_HOLDER)),
      ).toEqual({ code: 'LEAD_ENTRY_NOT_EDITABLE', status: 409 });

      storedEntry = buildEntry({ authorId: OTHER_MEMBER_ID });
      expect(
        await codeOf(service.deleteNote(LEAD_ID, ENTRY_ID, GRANT_HOLDER)),
      ).toEqual({ code: 'LEAD_NOTE_NOT_YOURS', status: 403 });
      expect(hasWritten()).toBe(false);

      storedEntry = buildEntry({ authorId: HOLDER_ID });
      manager.query.mockClear();
      manager.findOne.mockClear();
      const lead = await service.deleteNote(LEAD_ID, ENTRY_ID, GRANT_HOLDER);

      expectTableLockFirst();
      expect(manager.delete).toHaveBeenCalledWith(LeadEntry, { id: ENTRY_ID });
      expect(manager.query).toHaveBeenCalledWith(TOUCH_LEAD_SQL, [LEAD_ID]);
      expect(callOrderOf(manager.delete)).toBeLessThan(
        queryCallOrderOf(TOUCH_LEAD_SQL),
      );
      expect(leads.getLead).toHaveBeenCalledWith(LEAD_ID, GRANT_HOLDER);
      expect(lead).toBe(REFRESHED_LEAD);
    });
  });

  describe('revertStageChange', () => {
    const NOW = new Date('2026-11-14T10:05:00.000Z');
    const CHANGED_AT = new Date('2026-11-14T10:00:00.000Z');

    function buildStageChange(overrides: Partial<LeadEntry> = {}): LeadEntry {
      return buildEntry({
        kind: 'stage_changed',
        body: null,
        fromStage: 'to_contact',
        toStage: 'contacted',
        authorId: HOLDER_ID,
        createdAt: CHANGED_AT,
        ...overrides,
      });
    }

    beforeEach(() => {
      storedLead = { id: LEAD_ID, stage: 'contacted' };
      storedEntry = buildStageChange();
      newestStageChange = { id: ENTRY_ID };
    });

    it('restores the from stage, deletes the entry, writes no entry and answers the refreshed lead', async () => {
      const lead = await service.revertStageChange(
        LEAD_ID,
        ENTRY_ID,
        GRANT_HOLDER,
        NOW,
      );

      expectTableLockFirst();
      expect(manager.findOne).toHaveBeenCalledWith(Lead, {
        where: { id: LEAD_ID },
        select: { id: true, stage: true },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.findOne).toHaveBeenCalledWith(LeadEntry, {
        where: { id: ENTRY_ID, leadId: LEAD_ID },
      });
      expect(manager.findOne).toHaveBeenCalledWith(LeadEntry, {
        where: { leadId: LEAD_ID, kind: 'stage_changed' },
        select: { id: true },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      expect(manager.delete).toHaveBeenCalledTimes(1);
      expect(manager.delete).toHaveBeenCalledWith(LeadEntry, { id: ENTRY_ID });
      expect(manager.update).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledWith(Lead, LEAD_ID, {
        stage: 'to_contact',
        updatedAt: expect.any(Function) as () => string,
      });
      const [updateCall] = manager.update.mock.calls as [
        [unknown, string, { updatedAt: () => string }],
      ];
      expect(updateCall[2].updatedAt()).toBe('now()');
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.create).not.toHaveBeenCalled();
      expect(manager.query.mock.calls).toEqual([[LOCK_LEADS_SQL]]);
      expect(leads.getLead).toHaveBeenCalledWith(LEAD_ID, GRANT_HOLDER, NOW);
      expect(callOrderOf(dataSource.transaction)).toBeLessThan(
        callOrderOf(leads.getLead),
      );
      expect(lead).toBe(REFRESHED_LEAD);
    });

    it.each<{
      label: string;
      leadId: string;
      entryId: string;
      caller: LeadCaller;
      arrange?: () => void;
      code: string;
      status: number;
      reason?: LeadRevertRefusalReason;
    }>([
      {
        label: 'a malformed lead id',
        leadId: 'not-a-uuid',
        entryId: 'not-a-uuid',
        caller: ADMIN,
        code: 'LEAD_NOT_FOUND',
        status: 404,
      },
      {
        label: 'a malformed entry id',
        leadId: LEAD_ID,
        entryId: 'not-a-uuid',
        caller: ADMIN,
        code: 'LEAD_ENTRY_NOT_FOUND',
        status: 404,
      },
      {
        label: 'an unknown lead',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: ADMIN,
        arrange: () => {
          storedLead = null;
        },
        code: 'LEAD_NOT_FOUND',
        status: 404,
      },
      {
        label: 'a missing entry',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: ADMIN,
        arrange: () => {
          storedEntry = null;
        },
        code: 'LEAD_ENTRY_NOT_FOUND',
        status: 404,
      },
      {
        label: 'an entry on another lead',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: ADMIN,
        arrange: () => {
          storedEntry = buildStageChange({ leadId: OTHER_LEAD_ID });
        },
        code: 'LEAD_ENTRY_NOT_FOUND',
        status: 404,
      },
      {
        label: 'a note, even for its author',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: GRANT_HOLDER,
        arrange: () => {
          storedEntry = buildEntry({ authorId: HOLDER_ID, createdAt: NOW });
        },
        code: 'LEAD_ENTRY_NOT_REVERTIBLE',
        status: 409,
        reason: 'not_stage_change',
      },
      {
        label: 'a created entry',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: ADMIN,
        arrange: () => {
          storedEntry = buildStageChange({ kind: 'created', fromStage: null });
        },
        code: 'LEAD_ENTRY_NOT_REVERTIBLE',
        status: 409,
        reason: 'not_stage_change',
      },
      {
        label: 'a stage change followed by a newer one',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: GRANT_HOLDER,
        arrange: () => {
          storedLead = { id: LEAD_ID, stage: 'in_talks' };
          newestStageChange = { id: NEWER_ENTRY_ID };
        },
        code: 'LEAD_ENTRY_NOT_REVERTIBLE',
        status: 409,
        reason: 'not_newest',
      },
      {
        label: 'a lead whose stage was changed by something else',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: GRANT_HOLDER,
        arrange: () => {
          storedLead = { id: LEAD_ID, stage: 'on_board' };
        },
        code: 'LEAD_ENTRY_NOT_REVERTIBLE',
        status: 409,
        reason: 'stage_moved',
      },
      {
        label: "another member's stage change for a grant holder",
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: GRANT_HOLDER,
        arrange: () => {
          storedEntry = buildStageChange({ authorId: OTHER_MEMBER_ID });
        },
        code: 'LEAD_ENTRY_NOT_REVERTIBLE',
        status: 409,
        reason: 'not_yours',
      },
      {
        label: 'a stage change whose author is gone, for a grant holder',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: GRANT_HOLDER,
        arrange: () => {
          storedEntry = buildStageChange({ authorId: null });
        },
        code: 'LEAD_ENTRY_NOT_REVERTIBLE',
        status: 409,
        reason: 'not_yours',
      },
      {
        label: 'a stage change one millisecond past the window',
        leadId: LEAD_ID,
        entryId: ENTRY_ID,
        caller: ADMIN,
        arrange: () => {
          storedEntry = buildStageChange({
            createdAt: new Date(NOW.getTime() - LEAD_REVERT_WINDOW_MS - 1),
          });
        },
        code: 'LEAD_ENTRY_NOT_REVERTIBLE',
        status: 409,
        reason: 'too_old',
      },
    ])(
      'answers $code for $label and writes nothing',
      async ({ leadId, entryId, caller, arrange, code, status, reason }) => {
        arrange?.();

        const expected: RevertRefusalOutcome = { code, status };
        if (reason !== undefined) {
          expected.reason = reason;
        }
        expect(
          await revertRefusalOf(
            service.revertStageChange(leadId, entryId, caller, NOW),
          ),
        ).toEqual(expected);
        expect(hasWritten()).toBe(false);
        expect(leads.getLead).not.toHaveBeenCalled();
      },
    );

    it('refuses malformed ids before opening a transaction', async () => {
      await revertRefusalOf(
        service.revertStageChange('not-a-uuid', ENTRY_ID, ADMIN, NOW),
      );
      await revertRefusalOf(
        service.revertStageChange(LEAD_ID, 'not-a-uuid', ADMIN, NOW),
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('checks the five reasons in the contract order', async () => {
      storedEntry = buildStageChange({
        kind: 'note',
        body: 'first text',
        authorId: OTHER_MEMBER_ID,
        createdAt: new Date(NOW.getTime() - LEAD_REVERT_WINDOW_MS - 1),
      });
      storedLead = { id: LEAD_ID, stage: 'on_board' };
      newestStageChange = { id: NEWER_ENTRY_ID };
      const reasonOf = async (): Promise<string | undefined> =>
        (
          await revertRefusalOf(
            service.revertStageChange(LEAD_ID, ENTRY_ID, GRANT_HOLDER, NOW),
          )
        ).reason;

      expect(await reasonOf()).toBe('not_stage_change');
      storedEntry = { ...storedEntry, kind: 'stage_changed', body: null };
      expect(await reasonOf()).toBe('not_newest');
      newestStageChange = { id: ENTRY_ID };
      expect(await reasonOf()).toBe('stage_moved');
      storedLead = { id: LEAD_ID, stage: 'contacted' };
      expect(await reasonOf()).toBe('not_yours');
      storedEntry = { ...storedEntry, authorId: HOLDER_ID };
      expect(await reasonOf()).toBe('too_old');
      expect(hasWritten()).toBe(false);
    });

    it('reverts an entry exactly at the window edge', async () => {
      storedEntry = buildStageChange({
        createdAt: new Date(NOW.getTime() - LEAD_REVERT_WINDOW_MS),
      });

      const lead = await service.revertStageChange(
        LEAD_ID,
        ENTRY_ID,
        GRANT_HOLDER,
        NOW,
      );

      expect(manager.delete).toHaveBeenCalledWith(LeadEntry, { id: ENTRY_ID });
      expect(lead).toBe(REFRESHED_LEAD);
    });

    it("lets an Admin revert another member's stage change", async () => {
      storedEntry = buildStageChange({ authorId: OTHER_MEMBER_ID });

      const lead = await service.revertStageChange(
        LEAD_ID,
        ENTRY_ID,
        ADMIN,
        NOW,
      );

      expect(manager.delete).toHaveBeenCalledWith(LeadEntry, { id: ENTRY_ID });
      expect(manager.update).toHaveBeenCalledWith(
        Lead,
        LEAD_ID,
        expect.objectContaining({ stage: 'to_contact' }),
      );
      expect(leads.getLead).toHaveBeenCalledWith(LEAD_ID, ADMIN, NOW);
      expect(lead).toBe(REFRESHED_LEAD);
    });

    it('answers the second of two simultaneous reverts with LEAD_ENTRY_NOT_FOUND', async () => {
      // The table lock queues the two transactions; the mock runs them one
      // after the other the same way.
      let transactionQueue: Promise<unknown> = Promise.resolve();
      dataSource.transaction.mockImplementation(
        (work: (inner: EntityManager) => Promise<unknown>) => {
          const run = transactionQueue.then(() =>
            work(manager as unknown as EntityManager),
          );
          transactionQueue = run.catch(() => undefined);
          return run;
        },
      );
      manager.delete.mockImplementation(() => {
        storedEntry = null;
        return Promise.resolve({ affected: 1 });
      });
      manager.update.mockImplementation(
        (_entity: unknown, _leadId: string, values: { stage: string }) => {
          storedLead = {
            id: LEAD_ID,
            stage: values.stage as Lead['stage'],
          };
          return Promise.resolve({ affected: 1 });
        },
      );

      const [firstOutcome, secondOutcome] = await Promise.all([
        revertRefusalOf(
          service.revertStageChange(LEAD_ID, ENTRY_ID, GRANT_HOLDER, NOW),
        ),
        revertRefusalOf(
          service.revertStageChange(LEAD_ID, ENTRY_ID, ADMIN, NOW),
        ),
      ]);

      expect(firstOutcome).toEqual({});
      expect(secondOutcome).toEqual({
        code: 'LEAD_ENTRY_NOT_FOUND',
        status: 404,
      });
      expect(manager.delete).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledTimes(1);
      expect(storedLead).toEqual({ id: LEAD_ID, stage: 'to_contact' });
      expect(leads.getLead).toHaveBeenCalledTimes(1);
    });
  });

  it('answers the note code when a CHECK fires', async () => {
    manager.save.mockRejectedValueOnce(
      new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('check violation'), {
          code: '23514',
          constraint: 'CHK_lead_entries_body_length',
        }),
      ),
    );

    expect(
      await codeOf(service.addNote(LEAD_ID, ADMIN, { body: 'hello' })),
    ).toEqual({ code: 'LEAD_NOTE_TOO_LONG', status: 400 });
  });
});
